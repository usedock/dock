import { createHash, randomBytes, randomUUID } from 'crypto';

/** 256-bit opaque token, hex-encoded for URLs and API bodies. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 of a token for storage; raw values never touch the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newUuid(): string {
  return randomUUID();
}

/** Unpadded base64url for PKCE challenges. */
export function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
