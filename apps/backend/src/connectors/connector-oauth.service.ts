import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { BetterAuthService } from '../auth/better-auth/better-auth.service';
import { publicApiUrl, publicAppUrl } from '../config/instance';
import { REDIS } from '../redis/redis.module';
import { CONNECTOR_SPECS, type ConnectorKind } from './connector-kinds';
import { authorizeUrl, exchangeCode, newPkce, oauthClient, signState, STATE_TTL_SECONDS, verifyState } from './connector-oauth';
import { verifyCredential } from './connector-verify';
import { ConnectorsService } from './connectors.service';

/** Authorization-code flow per kind; state is HMAC-signed, single-use and bound to user and workspace. */
@Injectable()
export class ConnectorOauthService {
  private readonly secret: Buffer;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly connectors: ConnectorsService,
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly betterAuth: BetterAuthService,
    @Optional() options: { fetchFn?: typeof fetch } = {},
  ) {
    this.secret = Buffer.from(config.getOrThrow<string>('SECRETS_ENCRYPTION_KEY'), 'hex');
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async start(callerId: string, kind: string, workspaceId: string): Promise<{ url: string }> {
    const checked = this.connectors.kindOf(kind);
    const client = this.client(checked);
    const ws = await this.connectors.requireAdmin(callerId, workspaceId);
    const nonce = randomBytes(16).toString('hex');
    const pkce = newPkce();
    const usesPkce = CONNECTOR_SPECS[checked].oauth.pkce;
    await this.redis.set(this.nonceKey(nonce), usesPkce ? pkce.verifier : '', 'EX', STATE_TTL_SECONDS);
    const state = signState(this.secret, { u: callerId, w: ws.id, k: checked, n: nonce, e: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS });
    return { url: authorizeUrl(checked, client.id, this.redirectUri(checked), state, usesPkce ? pkce.challenge : null) };
  }

  /** Completes the flow and returns the dashboard URL to send the browser to; the browser must be signed in as the user who started it. */
  async callback(kind: string, query: { code?: string; state?: string; error?: string }, cookie?: string): Promise<string> {
    const checked = this.connectors.kindOf(kind);
    const state = verifyState(this.secret, query.state ?? '', checked);
    // Single use: a replayed callback finds the nonce gone.
    const stored = await this.redis.getdel(this.nonceKey(state.n));
    if (stored === null) throw new BadRequestException({ code: 'invalid_state', message: 'OAuth state is invalid or expired' });
    const back = (status: string, reason?: string) => this.appUrl(checked, status, reason);
    if (query.error || !query.code) return back('error', 'denied');
    // Without this, a link started by one user would store whoever approves it into that user's workspace.
    const session = await this.betterAuth.getSessionUser(cookie);
    if (session?.id !== state.u) return back('error', 'session_mismatch');
    try {
      await this.connectors.requireAdmin(state.u, state.w);
      const result = await exchangeCode(this.fetchFn, checked, this.client(checked), {
        code: query.code,
        redirectUri: this.redirectUri(checked),
        verifier: stored || null,
      });
      const label = result.label ?? (await verifyCredential(this.fetchFn, checked, result.credential).catch(() => null));
      await this.connectors.store(state.w, checked, result.credential, label, result.scopes, state.u);
      return back('connected');
    } catch (err) {
      return back('error', String((err as { response?: { code?: string } }).response?.code ?? 'failed'));
    }
  }

  private client(kind: ConnectorKind) {
    const client = oauthClient(this.config, kind);
    if (!client) {
      throw new BadRequestException({ code: 'oauth_not_configured', message: `Set ${kind.toUpperCase()}_CLIENT_ID and ${kind.toUpperCase()}_CLIENT_SECRET to enable OAuth for ${kind}` });
    }
    return client;
  }

  private redirectUri(kind: ConnectorKind): string {
    return `${publicApiUrl(this.config)}/v1/connectors/${kind}/oauth/callback`;
  }

  private appUrl(kind: ConnectorKind, status: string, reason?: string): string {
    const url = new URL(`${publicAppUrl(this.config)}/connectors`);
    url.searchParams.set('kind', kind);
    url.searchParams.set('status', status);
    if (reason) url.searchParams.set('reason', reason);
    return url.toString();
  }

  private nonceKey(nonce: string): string {
    return `connector:oauth:${nonce}`;
  }
}
