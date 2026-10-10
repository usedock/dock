import { newToken, hashToken } from '../crypto/tokens';
import { signWebhook, verifyWebhook, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from './webhook-signing';

const SECRET = 'whsec_test_endpoint_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'dock.ready' });

describe('webhook-signing', () => {
  it('round-trips a fresh signature', () => {
    expect(verifyWebhook(SECRET, signWebhook(SECRET, BODY), BODY)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signWebhook(SECRET, BODY);
    expect(verifyWebhook(SECRET, signature, `${BODY} `)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const signature = signWebhook(SECRET, BODY);
    expect(verifyWebhook('whsec_other_secret', signature, BODY)).toBe(false);
  });

  it('rejects an expired timestamp', () => {
    const old = Math.floor(Date.now() / 1000) - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(verifyWebhook(SECRET, signWebhook(SECRET, BODY, old), BODY)).toBe(false);
  });

  it('accepts a signature at the tolerance edge', () => {
    const now = Math.floor(Date.now() / 1000);
    const edge = now - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
    expect(verifyWebhook(SECRET, signWebhook(SECRET, BODY, edge), BODY, now)).toBe(true);
  });

  it('rejects malformed headers and empty inputs', () => {
    expect(verifyWebhook(SECRET, 'not-a-signature', BODY)).toBe(false);
    expect(verifyWebhook(SECRET, undefined, BODY)).toBe(false);
    expect(verifyWebhook('', signWebhook(SECRET, BODY), BODY)).toBe(false);
  });

  it('seals endpoint identity without storing the raw secret', () => {
    const raw = newToken();
    const stored = hashToken(raw);
    expect(stored).not.toContain(raw);
    expect(stored).toHaveLength(64);
    expect(verifyWebhook(raw, signWebhook(raw, BODY), BODY)).toBe(true);
  });
});
