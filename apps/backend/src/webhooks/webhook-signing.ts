import { createHmac, timingSafeEqual } from 'node:crypto';

/** Receiver clock-skew tolerance, matching the inbound Stripe-style window. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** HMAC-SHA256 over `<unix-seconds>.<raw-body>`; receivers recompute with the endpoint secret. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Verifies shape, freshness, and digest in constant time; never throws. */
export function verifyWebhook(
  secret: string,
  signature: string | undefined,
  body: string,
  nowSeconds = Date.now() / 1000,
): boolean {
  if (!secret || !signature) return false;
  const match = /(?:^|,\s*)t=(\d+),\s*v1=([0-9a-f]+)/.exec(signature);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${match[1]}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(match[2], 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
