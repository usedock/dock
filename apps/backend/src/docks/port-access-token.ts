import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import type { ConfigReader } from '../config/instance';

/** `exchange` rides one redirect through the URL; `session` lives in the port host's cookie. */
export type PortTokenKind = 'exchange' | 'session';

export const EXCHANGE_TTL_SECONDS = 60;
export const SESSION_TTL_SECONDS = 8 * 3600;

interface Payload {
  k: PortTokenKind;
  /** Port label the token is bound to. */
  l: string;
  /** User id. */
  u: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

function key(config: ConfigReader, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', config.get<string>('BETTER_AUTH_SECRET') ?? '', Buffer.alloc(0), purpose, 32));
}

function mac(secret: Buffer, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signed `<payload>.<mac>` token for one port label and user. */
export function signPortToken(config: ConfigReader, kind: PortTokenKind, label: string, userId: string, ttlSeconds: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ k: kind, l: label, u: userId, exp: Math.floor(now / 1000) + ttlSeconds } satisfies Payload)).toString('base64url');
  return `${payload}.${mac(key(config, 'dock-port-access'), payload).toString('base64url')}`;
}

/** The user id of a valid, unexpired token of this kind for this label; null otherwise. */
export function verifyPortToken(config: ConfigReader, kind: PortTokenKind, label: string, token: string, now = Date.now()): string | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!equal(Buffer.from(signature, 'base64url'), mac(key(config, 'dock-port-access'), payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Payload>;
    if (parsed.k !== kind || parsed.l !== label || typeof parsed.u !== 'string' || typeof parsed.exp !== 'number') return null;
    return parsed.exp * 1000 > now ? parsed.u : null;
  } catch {
    return null;
  }
}

/** Host-only cookie on a private port host holding a `session` token. */
export const PORT_COOKIE = 'dock_port_access';

/** Header the edge sets after the access check passes; the proxy refuses private ports without it. */
export const EDGE_PROOF_HEADER = 'x-dock-port-auth';

/** Proofs older than this are refused, and the edge mints a fresh one per request. */
export const EDGE_PROOF_MAX_AGE_SECONDS = 60;
const EDGE_PROOF_SKEW_SECONDS = 5;

/** Dedicated key when DOCK_PORT_PROOF_SECRET is set, else a subkey of BETTER_AUTH_SECRET with its own label. */
function proofKey(config: ConfigReader): Buffer {
  const dedicated = config.get<string>('DOCK_PORT_PROOF_SECRET');
  if (dedicated) return Buffer.from(hkdfSync('sha256', dedicated, Buffer.alloc(0), 'dock-port-proof-secret', 32));
  return key(config, 'dock-port-proof-v1');
}

function proofMac(config: ConfigReader, label: string, ts: string): Buffer {
  return mac(proofKey(config), `${label}|${ts}`);
}

/** `v1.<unixSeconds>.<hmac(label|ts)>` for one port label. */
export function edgeProof(config: ConfigReader, label: string, now = Date.now()): string {
  const ts = String(Math.floor(now / 1000));
  return `v1.${ts}.${proofMac(config, label, ts).toString('hex')}`;
}

export function edgeProofValid(config: ConfigReader, label: string, presented: string | null, now = Date.now()): boolean {
  const [version, ts, signature, extra] = (presented ?? '').split('.');
  if (version !== 'v1' || !ts || !signature || extra !== undefined || !/^\d{1,12}$/.test(ts)) return false;
  const age = Math.floor(now / 1000) - Number(ts);
  if (age > EDGE_PROOF_MAX_AGE_SECONDS || age < -EDGE_PROOF_SKEW_SECONDS) return false;
  return equal(Buffer.from(signature, 'hex'), proofMac(config, label, ts));
}
