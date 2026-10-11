import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { base64url } from '../crypto/tokens';
import { CONNECTOR_SPECS, envStem, type ConnectorCredential, type ConnectorKind } from './connector-kinds';

export const STATE_TTL_SECONDS = 600;
const REFRESH_SKEW_MS = 60_000;

export interface OauthState {
  /** User, workspace, kind, single-use nonce, expiry (epoch seconds). */
  u: string;
  w: string;
  k: ConnectorKind;
  n: string;
  e: number;
}

export function invalidState(): BadRequestException {
  return new BadRequestException({ code: 'invalid_state', message: 'OAuth state is invalid or expired' });
}

function mac(secret: Buffer, body: string): string {
  return base64url(createHmac('sha256', secret).update(`connector-oauth:${body}`).digest());
}

/** HMAC-signed state carrying the user and workspace the flow was started for. */
export function signState(secret: Buffer, state: OauthState): string {
  const body = base64url(Buffer.from(JSON.stringify(state)));
  return `${body}.${mac(secret, body)}`;
}

/** Throws invalid_state on tamper, wrong kind or expiry. */
export function verifyState(secret: Buffer, raw: string, kind: ConnectorKind, nowMs = Date.now()): OauthState {
  const [body, sig, extra] = String(raw ?? '').split('.');
  if (!body || !sig || extra !== undefined) throw invalidState();
  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalidState();
  let state: OauthState;
  try {
    state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OauthState;
  } catch {
    throw invalidState();
  }
  if (state.k !== kind || typeof state.e !== 'number' || state.e * 1000 < nowMs) throw invalidState();
  return state;
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function oauthClient(config: { get<T = string>(k: string): T | undefined }, kind: ConnectorKind): { id: string; secret: string } | null {
  const id = config.get<string>(`${envStem(kind)}_CLIENT_ID`);
  const secret = config.get<string>(`${envStem(kind)}_CLIENT_SECRET`);
  return id && secret ? { id, secret } : null;
}

export function authorizeUrl(kind: ConnectorKind, clientId: string, redirectUri: string, state: string, challenge: string | null): string {
  const { oauth } = CONNECTOR_SPECS[kind];
  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', oauth.scopes.join(oauth.scopeSeparator));
  url.searchParams.set('state', state);
  if (challenge) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

export interface TokenResult {
  credential: ConnectorCredential;
  scopes: string[];
  /** Account label when the token response carries one (Slack team). */
  label: string | null;
}

function unavailable(): BadGatewayException {
  return new BadGatewayException({ code: 'connector_unreachable', message: 'The tool rejected or could not complete the sign-in' });
}

async function tokenCall(
  fetchFn: typeof fetch,
  url: string,
  client: { id: string; secret: string },
  basic: boolean,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`;
  else {
    body.set('client_id', client.id);
    body.set('client_secret', client.secret);
  }
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw unavailable();
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.ok === false || json.error) throw unavailable();
  return json;
}

function parseToken(kind: ConnectorKind, json: Record<string, unknown>, now: number, previousRefresh?: string): TokenResult {
  const access = String(json.access_token ?? json.token ?? '');
  if (!access) throw unavailable();
  const refresh = (json.refresh_token ?? json.refreshToken) as string | undefined;
  const credential: ConnectorCredential = { type: 'oauth', access };
  if (refresh ?? previousRefresh) credential.refresh = refresh ?? previousRefresh;
  if (typeof json.expires_in === 'number') credential.expiresAt = now + json.expires_in * 1000;
  else if (typeof json.expiresAt === 'string' && !Number.isNaN(Date.parse(json.expiresAt))) credential.expiresAt = Date.parse(json.expiresAt);
  const rawScope = json.scope ?? json.scopes;
  const scopes = Array.isArray(rawScope) ? rawScope.map(String) : typeof rawScope === 'string' ? rawScope.split(/[ ,]+/).filter(Boolean) : [];
  const team = json.team as { name?: string } | undefined;
  return { credential, scopes, label: kind === 'slack' ? (team?.name ?? null) : null };
}

export async function exchangeCode(
  fetchFn: typeof fetch,
  kind: ConnectorKind,
  client: { id: string; secret: string },
  args: { code: string; redirectUri: string; verifier: string | null },
  now = Date.now(),
): Promise<TokenResult> {
  const { oauth } = CONNECTOR_SPECS[kind];
  const params: Record<string, string> = { grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri };
  if (args.verifier) params.code_verifier = args.verifier;
  return parseToken(kind, await tokenCall(fetchFn, oauth.tokenUrl, client, oauth.basicAuth, params), now);
}

/** Null when the credential has no refresh path; otherwise a fresh credential. */
export async function refreshCredential(
  fetchFn: typeof fetch,
  kind: ConnectorKind,
  client: { id: string; secret: string },
  cred: ConnectorCredential,
  now = Date.now(),
): Promise<ConnectorCredential | null> {
  if (!cred.refresh) return null;
  const { oauth } = CONNECTOR_SPECS[kind];
  const json = await tokenCall(fetchFn, oauth.refreshUrl ?? oauth.tokenUrl, client, oauth.basicAuth, {
    grant_type: 'refresh_token',
    refresh_token: cred.refresh,
  });
  return parseToken(kind, json, now, cred.refresh).credential;
}

export function needsRefresh(cred: ConnectorCredential, now = Date.now()): boolean {
  return cred.type === 'oauth' && cred.expiresAt !== undefined && cred.expiresAt - REFRESH_SKEW_MS <= now;
}
