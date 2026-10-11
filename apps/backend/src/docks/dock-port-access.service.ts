import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { AccountClosureService } from '../account-closure/account-closure.service';
import { API_KEY_PREFIX } from '../api-keys/api-keys.service';
import { BetterAuthService } from '../auth/better-auth/better-auth.service';
import { publicApiUrl, publicAppUrl } from '../config/instance';
import { hashToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { apiKeys, dockPorts } from '../database/schema';
import { DockPortsService } from './dock-ports.service';
import { PortAuthCache } from './port-auth-cache';
import { DocksService } from './docks.service';
import { edgeProof, EXCHANGE_TTL_SECONDS, PORT_COOKIE, SESSION_TTL_SECONDS, signPortToken, verifyPortToken } from './port-access-token';

/** Path on a port host where the edge check turns an exchange token into a cookie. */
export const PORT_AUTH_PATH = '/__dock/auth';

export interface PortAuthInput {
  host?: string;
  uri?: string;
  cookie?: string;
  authorization?: string;
  /** True for browser navigations, which get a login redirect instead of a bare 401. */
  wantsHtml: boolean;
}

export type PortAuthResult =
  | { status: 200; headers: Record<string, string> }
  | { status: 302; location: string; setCookie?: string }
  | { status: 401 }
  | { status: 404 };

/** A same-origin path with no scheme or control characters; anything else becomes `/`. */
export function safePath(value: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!value || !value.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(value)) return '/';
  try {
    const url = new URL(value, 'http://dock.invalid');
    const out = url.pathname + url.search;
    return url.origin === 'http://dock.invalid' && !out.startsWith('//') ? out : '/';
  } catch {
    return '/';
  }
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Access control for private hosted ports: the edge asks here before forwarding a request. */
@Injectable()
export class DockPortAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    private readonly ports: DockPortsService,
    private readonly betterAuth: BetterAuthService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => AccountClosureService)) private readonly closures: AccountClosureService,
    private readonly cache: PortAuthCache,
  ) {}

  /** Edge forward-auth decision for one request to a port host. */
  async authorize(input: PortAuthInput): Promise<PortAuthResult> {
    const label = input.host ? this.ports.labelFor(input.host) : null;
    const port = label ? await this.findPort(label) : null;
    if (!label || !port) return { status: 404 };
    if (port.visibility === 'public') return { status: 200, headers: {} };

    const url = new URL(input.uri || '/', 'http://dock.invalid');
    const granted = { status: 200 as const, headers: { 'X-Dock-Port-Auth': edgeProof(this.config, label) } };
    if (url.pathname === PORT_AUTH_PATH) return this.startSession(label, port.dockId, url);

    const [type, bearer] = (input.authorization ?? '').split(' ');
    if (type === 'Bearer' && bearer && (await this.cached(label, `bearer:${bearer}`, port.dockId, () => this.dockKeyMatches(bearer, port.dockId)))) return granted;

    const session = cookieValue(input.cookie, PORT_COOKIE);
    const userId = session ? verifyPortToken(this.config, 'session', label, session) : null;
    if (session && userId && (await this.cached(label, `cookie:${session}`, port.dockId, () => this.isMember(userId, port.dockId)))) return granted;

    if (!input.wantsHtml) return { status: 401 };
    const api = publicApiUrl(this.config);
    const next = safePath(input.uri);
    return { status: 302, location: `${api}/v1/ports/access?host=${encodeURIComponent(this.ports.hostFor(label))}&next=${encodeURIComponent(next)}` };
  }

  /** Signed-in browser landing: sends org members on to the port host with a short-lived exchange token. */
  async access(host: string | undefined, next: string | undefined, cookie: string | undefined): Promise<PortAuthResult> {
    const label = host ? this.ports.labelFor(host) : null;
    const port = label ? await this.findPort(label) : null;
    if (!label || !port || port.visibility !== 'private') return { status: 404 };
    const safe = safePath(next);
    const user = await this.betterAuth.getSessionUser(cookie);
    if (!user) {
      const self = `/v1/ports/access?host=${encodeURIComponent(this.ports.hostFor(label))}&next=${encodeURIComponent(safe)}`;
      const sameOrigin = new URL(publicAppUrl(this.config)).origin === new URL(publicApiUrl(this.config)).origin;
      return { status: 302, location: `${publicAppUrl(this.config)}/auth/login${sameOrigin ? `?next=${encodeURIComponent(self)}` : ''}` };
    }
    if (!(await this.isMember(user.id, port.dockId))) return { status: 404 };
    const token = signPortToken(this.config, 'exchange', label, user.id, EXCHANGE_TTL_SECONDS);
    return { status: 302, location: `${this.ports.originFor(label)}${PORT_AUTH_PATH}?token=${encodeURIComponent(token)}&next=${encodeURIComponent(safe)}` };
  }

  /** A fresh grant for this credential skips the checks; only grants are remembered, so a denial is always rechecked. */
  private async cached(label: string, credential: string, dockId: string, check: () => Promise<boolean>): Promise<boolean> {
    if (this.cache.has(label, credential, dockId)) return true;
    const ok = await check();
    if (ok) this.cache.grant(label, credential, dockId);
    return ok;
  }

  /** Trades an exchange token for the port host's session cookie. */
  private async startSession(label: string, dockId: string, url: URL): Promise<PortAuthResult> {
    const userId = verifyPortToken(this.config, 'exchange', label, url.searchParams.get('token') ?? '');
    if (!userId || !(await this.isMember(userId, dockId))) return { status: 401 };
    const secure = new URL(publicApiUrl(this.config)).protocol === 'https:' ? '; Secure' : '';
    const token = signPortToken(this.config, 'session', label, userId, SESSION_TTL_SECONDS);
    return {
      status: 302,
      location: safePath(url.searchParams.get('next')),
      setCookie: `${PORT_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
    };
  }

  private async findPort(label: string) {
    const [row] = await this.db.select({ dockId: dockPorts.dockId, visibility: dockPorts.visibility }).from(dockPorts).where(eq(dockPorts.label, label)).limit(1);
    return row ?? null;
  }

  /** Open account and the same dock rule as its shell (connector docks and admins-only secrets exclude plain members); a closed account loses port access like it loses the API. */
  private async isMember(userId: string, dockId: string): Promise<boolean> {
    try {
      if ((await this.closures.guardCheck(userId)) !== 'ok') return false;
      await this.docks.loadReadableDock(userId, dockId);
      return true;
    } catch {
      return false;
    }
  }

  /** Only a live API key bound to this very dock, whose owner may still use the dock, opens its private ports. */
  private async dockKeyMatches(raw: string, dockId: string): Promise<boolean> {
    if (!raw.startsWith(API_KEY_PREFIX)) return false;
    const [key] = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashToken(raw))).limit(1);
    if (!key || key.revokedAt || key.dockId !== dockId) return false;
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return false;
    return this.isMember(key.userId, dockId);
  }
}
