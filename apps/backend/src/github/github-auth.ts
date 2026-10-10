import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

/** `sha256=<hex>` over the exact raw body; the App private key is never valid here. */
export function verifyGithubSignature(
  secret: string,
  signature: string | string[] | undefined,
  rawBody: Buffer | string,
): boolean {
  if (!secret || signature === undefined) return false;
  const received = Array.isArray(signature) ? signature[0] : signature;
  if (typeof received !== 'string' || !received.startsWith('sha256=')) return false;
  const hex = received.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(hex.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Short-lived App JWT for the token exchange; never used on repo endpoints directly. */
export function mintAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const issued = Math.floor(nowMs / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: issued, exp: issued + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem, 'base64url')}`;
}

/** App JWT from the current key, falling back to the previous one during rotation. */
export function mintAppJwtWithRotation(appId: string, current: string, prev: string, nowMs = Date.now()): string {
  if (!appId || !current) throw new Error('github app not configured');
  try {
    return mintAppJwt(appId, current, nowMs);
  } catch {
    if (!prev) throw new Error('github app not configured');
    return mintAppJwt(appId, prev, nowMs);
  }
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** Exchanges an App JWT for a single-repo installation token. `fetchFn` is injectable for tests. */
export async function exchangeInstallationToken(input: {
  apiBase: string;
  jwt: string;
  installationId: number;
  /** Omit for a token over every repository the installation grants. */
  repositories?: string[];
  /** Narrows the token below the App grant, e.g. `{ contents: 'read' }` for guest clones. */
  permissions?: Record<string, 'read' | 'write'>;
  fetchFn?: typeof fetch;
}): Promise<InstallationToken> {
  const doFetch = input.fetchFn ?? fetch;
  const res = await doFetch(
    `${input.apiBase}/app/installations/${input.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.jwt}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ repositories: input.repositories, ...(input.permissions ? { permissions: input.permissions } : {}) }),
    },
  );
  if (!res.ok) throw new Error(`token mint failed with status ${res.status}`);
  const data = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof data.token !== 'string' || !data.token) throw new Error('token mint returned no token');
  return { token: data.token, expiresAt: typeof data.expires_at === 'string' ? data.expires_at : '' };
}
