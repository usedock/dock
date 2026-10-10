import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { RateLimitService } from '../auth/rate-limit.service';
import { DB, Db } from '../database/database.module';
import { chatgptConnections, type ChatgptConnection } from '../database/schema';
import { openValue, sealValue } from '../environments/secrets';
import { REDIS } from '../redis/redis.module';

/** The public Codex CLI client; OpenAI offers no third-party ChatGPT sign-in. */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;
/** OpenAI expires device codes after 15 minutes. */
const DEVICE_TTL_SECONDS = 900;
/** Refresh this long before expiry so a streaming request never starts on a dying token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_LOCK_SECONDS = 30;
const REFRESH_WAIT_STEPS = 20;
const REFRESH_WAIT_MS = 250;
const START_LIMIT = 10;

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface SealedTokens {
  access: string;
  refresh: string;
}

interface AuthClaims {
  email?: string;
  chatgpt_account_id?: string;
  organizations?: { id: string }[];
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    chatgpt_compute_residency?: string;
  };
  'https://api.openai.com/profile'?: { email?: string };
}

export interface ChatgptConnectionMeta {
  connected: boolean;
  status: ChatgptConnection['status'] | null;
  email: string | null;
  planType: string | null;
  updatedAt: Date | null;
}

export interface ChatgptAccess {
  access: string;
  accountId: string | null;
  /** Codex routing hint carried in the token; null when unconstrained. */
  residency: string | null;
}

export function jwtClaims(token: string | undefined): AuthClaims {
  const part = token?.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as AuthClaims;
  } catch {
    return {};
  }
}

function accountIdOf(claims: AuthClaims): string | null {
  return claims.chatgpt_account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.organizations?.[0]?.id ?? null;
}

export class ChatgptNotConnectedException extends NotFoundException {
  constructor() {
    super({ code: 'chatgpt_not_connected', message: 'No ChatGPT subscription is connected' });
  }
}

/**
 * Personal ChatGPT subscription sign-in through OpenAI's Codex device flow.
 * Tokens are sealed per user and only ever leave as an access token on the
 * LLM gateway's upstream request; refresh is single-flight because OpenAI
 * rotates refresh tokens and a replayed one can revoke the sign-in.
 */
@Injectable()
export class ChatgptService {
  private readonly key: Buffer;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refreshing = new Map<string, Promise<ChatgptAccess>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
    @Optional() options: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.key = Buffer.from(config.getOrThrow<string>('SECRETS_ENCRYPTION_KEY'), 'hex');
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get enabled(): boolean {
    return this.config.get<string>('CHATGPT_SIGNIN_ENABLED') === 'true';
  }

  async get(userId: string): Promise<ChatgptConnectionMeta> {
    const row = await this.row(userId);
    return {
      connected: !!row,
      status: row?.status ?? null,
      email: row?.email ?? null,
      planType: row?.planType ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Opens a device code; the user enters it at the verification URL while the dashboard polls. */
  async start(userId: string) {
    this.requireEnabled();
    const hit = await this.limits.hit(`rl:chatgpt-device:${userId}`, START_LIMIT, 3600);
    if (!hit.allowed) throw new HttpException({ code: 'rate_limited', message: 'Too many sign-in attempts' }, HttpStatus.TOO_MANY_REQUESTS);
    const res = await this.call(`${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    });
    if (!res.ok) throw new BadGatewayException({ code: 'chatgpt_unavailable', message: `OpenAI answered ${res.status}` });
    const data = (await res.json()) as { device_auth_id: string; user_code: string; interval?: string };
    const interval = Math.max(Number.parseInt(data.interval ?? '', 10) || 5, 1);
    await this.redis.set(
      this.deviceKey(userId),
      JSON.stringify({ deviceAuthId: data.device_auth_id, userCode: data.user_code }),
      'EX',
      DEVICE_TTL_SECONDS,
    );
    return {
      userCode: data.user_code,
      verificationUrl: CHATGPT_VERIFICATION_URL,
      intervalSeconds: interval,
      expiresAt: new Date(Date.now() + DEVICE_TTL_SECONDS * 1000),
    };
  }

  /** One poll of the pending device code; stores the sign-in once the user approves. */
  async poll(userId: string): Promise<{ state: 'pending' } | ({ state: 'connected' } & ChatgptConnectionMeta)> {
    this.requireEnabled();
    const raw = await this.redis.get(this.deviceKey(userId));
    if (!raw) throw new BadRequestException({ code: 'device_code_expired', message: 'Sign-in expired; start again' });
    const device = JSON.parse(raw) as { deviceAuthId: string; userCode: string };
    const res = await this.call(`${CHATGPT_ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    });
    if (res.status === 403 || res.status === 404) return { state: 'pending' };
    if (!res.ok) throw new BadGatewayException({ code: 'chatgpt_unavailable', message: `OpenAI answered ${res.status}` });
    const grant = (await res.json()) as { authorization_code: string; code_verifier: string };
    const tokens = await this.token({
      grant_type: 'authorization_code',
      code: grant.authorization_code,
      redirect_uri: `${CHATGPT_ISSUER}/deviceauth/callback`,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: grant.code_verifier,
    });
    if (!tokens) throw new BadGatewayException({ code: 'chatgpt_unavailable', message: 'OpenAI rejected the sign-in' });
    await this.redis.del(this.deviceKey(userId));
    await this.store(userId, tokens);
    return { state: 'connected', ...(await this.get(userId)) };
  }

  async remove(userId: string): Promise<ChatgptConnectionMeta> {
    const deleted = await this.db.delete(chatgptConnections).where(eq(chatgptConnections.userId, userId)).returning({ id: chatgptConnections.id });
    if (!deleted.length) throw new ChatgptNotConnectedException();
    return { connected: false, status: null, email: null, planType: null, updatedAt: null };
  }

  /** Whether runs may bill this user's subscription right now. */
  async usable(userId: string): Promise<boolean> {
    if (!this.enabled) return false;
    return (await this.row(userId))?.status === 'active';
  }

  /** Gateway path: a live access token, refreshed once across concurrent requests and replicas. */
  async accessFor(userId: string): Promise<ChatgptAccess> {
    if (!this.enabled) throw new ChatgptNotConnectedException();
    const row = await this.row(userId);
    if (!row || row.status !== 'active') throw new ChatgptNotConnectedException();
    if (!this.stale(row)) return this.accessOf(row);
    let pending = this.refreshing.get(userId);
    if (!pending) {
      pending = this.refresh(userId).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, pending);
    }
    return pending;
  }

  private async refresh(userId: string): Promise<ChatgptAccess> {
    const lock = `chatgpt:refresh:${userId}`;
    const acquired = await this.redis.set(lock, '1', 'EX', REFRESH_LOCK_SECONDS, 'NX');
    if (!acquired) {
      // Another replica holds the refresh token; wait for its rotated row.
      for (let i = 0; i < REFRESH_WAIT_STEPS; i++) {
        await this.sleep(REFRESH_WAIT_MS);
        const row = await this.row(userId);
        if (!row || row.status !== 'active') throw new ChatgptNotConnectedException();
        if (!this.stale(row)) return this.accessOf(row);
      }
      throw new BadGatewayException({ code: 'chatgpt_unavailable', message: 'ChatGPT token refresh timed out' });
    }
    try {
      const row = await this.row(userId);
      if (!row || row.status !== 'active') throw new ChatgptNotConnectedException();
      if (!this.stale(row)) return this.accessOf(row);
      const sealed = JSON.parse(openValue(this.key, row.secret)) as SealedTokens;
      const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: sealed.refresh, client_id: CHATGPT_CLIENT_ID });
      if (!tokens) {
        await this.db
          .update(chatgptConnections)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(chatgptConnections.userId, userId));
        throw new ChatgptNotConnectedException();
      }
      return this.accessOf(await this.store(userId, tokens));
    } finally {
      await this.redis.del(lock);
    }
  }

  /** Token endpoint call; null means OpenAI refused the grant (revoked, reused, or expired). */
  private async token(form: Record<string, string>): Promise<TokenResponse | null> {
    const res = await this.call(`${CHATGPT_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (res.status === 400 || res.status === 401) return null;
    if (!res.ok) throw new BadGatewayException({ code: 'chatgpt_unavailable', message: `OpenAI answered ${res.status}` });
    return (await res.json()) as TokenResponse;
  }

  private async store(userId: string, tokens: TokenResponse): Promise<ChatgptConnection> {
    const id = jwtClaims(tokens.id_token);
    const access = jwtClaims(tokens.access_token);
    const auth = id['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth'];
    const values = {
      accountId: accountIdOf(id) ?? accountIdOf(access),
      email: id.email ?? access['https://api.openai.com/profile']?.email ?? null,
      planType: auth?.chatgpt_plan_type ?? null,
      status: 'active' as const,
      secret: sealValue(this.key, JSON.stringify({ access: tokens.access_token, refresh: tokens.refresh_token } satisfies SealedTokens)),
      accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(chatgptConnections)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: chatgptConnections.userId, set: values })
      .returning();
    return row;
  }

  private accessOf(row: ChatgptConnection): ChatgptAccess {
    const { access } = JSON.parse(openValue(this.key, row.secret)) as SealedTokens;
    const residency = jwtClaims(access)['https://api.openai.com/auth']?.chatgpt_compute_residency;
    return { access, accountId: row.accountId, residency: residency && residency !== 'no_constraint' ? residency : null };
  }

  private stale(row: ChatgptConnection): boolean {
    return row.accessExpiresAt.getTime() - REFRESH_MARGIN_MS <= Date.now();
  }

  private async row(userId: string): Promise<ChatgptConnection | null> {
    const rows = await this.db.select().from(chatgptConnections).where(eq(chatgptConnections.userId, userId)).limit(1);
    return rows[0] ?? null;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (err) {
      throw new BadGatewayException({ code: 'chatgpt_unavailable', message: `OpenAI unreachable: ${(err as Error).message}` });
    }
  }

  private deviceKey(userId: string): string {
    return `chatgpt:device:${userId}`;
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new ForbiddenException({ code: 'chatgpt_signin_disabled', message: 'ChatGPT sign-in is off on this instance (CHATGPT_SIGNIN_ENABLED)' });
    }
  }
}
