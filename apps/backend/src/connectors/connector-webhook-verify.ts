import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Vendor replay windows: Linear asks for one minute, Slack allows five. */
export const LINEAR_WINDOW_MS = 60_000;
export const SLACK_WINDOW_SECONDS = 300;

export type SignatureCheck = 'ok' | 'bad_signature' | 'stale';

/** Constant-time string compare; hashing first hides length differences. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function anySecret(secrets: string[], match: (secret: string) => boolean): boolean {
  // Every secret is tried so timing does not reveal which one matched.
  return secrets.map(match).some(Boolean);
}

/** Linear: hex HMAC-SHA256 of the raw body, then webhookTimestamp (epoch ms) within a minute. */
export function verifyLinear(secrets: string[], rawBody: Buffer, signature: string | undefined, webhookTimestamp: unknown, nowMs = Date.now()): SignatureCheck {
  if (!signature || !anySecret(secrets, (s) => safeEqual(hmacHex(s, rawBody), signature))) return 'bad_signature';
  if (typeof webhookTimestamp !== 'number' || Math.abs(nowMs - webhookTimestamp) > LINEAR_WINDOW_MS) return 'stale';
  return 'ok';
}

/** Slack: `v0=` + hex HMAC-SHA256 of `v0:{timestamp}:{raw body}`, timestamp within five minutes. */
export function verifySlack(secrets: string[], rawBody: Buffer, signature: string | undefined, timestamp: string | undefined, nowMs = Date.now()): SignatureCheck {
  const ts = Number(timestamp);
  if (!signature || !timestamp || !Number.isFinite(ts)) return 'bad_signature';
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody]);
  if (!anySecret(secrets, (s) => safeEqual(`v0=${hmacHex(s, base)}`, signature))) return 'bad_signature';
  return Math.abs(nowMs / 1000 - ts) > SLACK_WINDOW_SECONDS ? 'stale' : 'ok';
}

/** Sentry: hex HMAC-SHA256 of the JSON body with the client secret; the vendor's sample hashes the re-serialized body, so both forms are accepted. */
export function verifySentry(secrets: string[], rawBody: Buffer, signature: string | undefined, parsed: unknown): SignatureCheck {
  if (!signature) return 'bad_signature';
  let compact = '';
  try {
    compact = JSON.stringify(parsed);
  } catch {
    compact = '';
  }
  const ok = anySecret(secrets, (s) => safeEqual(hmacHex(s, rawBody), signature) || (compact !== '' && safeEqual(hmacHex(s, compact), signature)));
  return ok ? 'ok' : 'bad_signature';
}

/** Figma webhooks v2 carry the passcode set at creation in every payload. */
export function verifyFigma(secrets: string[], passcode: unknown): SignatureCheck {
  if (typeof passcode !== 'string' || !passcode) return 'bad_signature';
  return anySecret(secrets, (s) => safeEqual(s, passcode)) ? 'ok' : 'bad_signature';
}
