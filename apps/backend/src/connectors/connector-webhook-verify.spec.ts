import { createHmac } from 'crypto';
import { verifyFigma, verifyLinear, verifySentry, verifySlack } from './connector-webhook-verify';

const hex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const NOW = 1_800_000_000_000;

describe('verifyLinear', () => {
  const body = Buffer.from(JSON.stringify({ webhookTimestamp: NOW, type: 'Issue' }));

  it('accepts the hex HMAC of the raw body with a fresh timestamp', () => {
    expect(verifyLinear(['s3cret'], body, hex('s3cret', body), NOW - 30_000, NOW)).toBe('ok');
  });

  it('refuses a wrong secret, a missing header and a tampered body', () => {
    expect(verifyLinear(['s3cret'], body, hex('other', body), NOW, NOW)).toBe('bad_signature');
    expect(verifyLinear(['s3cret'], body, undefined, NOW, NOW)).toBe('bad_signature');
    expect(verifyLinear(['s3cret'], Buffer.from('{}'), hex('s3cret', body), NOW, NOW)).toBe('bad_signature');
    expect(verifyLinear([], body, hex('s3cret', body), NOW, NOW)).toBe('bad_signature');
  });

  it('refuses a validly signed body whose webhookTimestamp is stale or missing', () => {
    const sig = hex('s3cret', body);
    expect(verifyLinear(['s3cret'], body, sig, NOW - 61_000, NOW)).toBe('stale');
    expect(verifyLinear(['s3cret'], body, sig, undefined, NOW)).toBe('stale');
  });
});

describe('verifySlack', () => {
  const body = Buffer.from('{"type":"event_callback"}');
  const ts = String(NOW / 1000);
  const sign = (secret: string, stamp = ts) => `v0=${hex(secret, `v0:${stamp}:${body.toString()}`)}`;

  it('accepts v0 over the timestamp and raw body', () => {
    expect(verifySlack(['sign'], body, sign('sign'), ts, NOW)).toBe('ok');
  });

  it('refuses a wrong secret, a signature for another timestamp and malformed input', () => {
    expect(verifySlack(['sign'], body, sign('nope'), ts, NOW)).toBe('bad_signature');
    expect(verifySlack(['sign'], body, sign('sign', '1'), ts, NOW)).toBe('bad_signature');
    expect(verifySlack(['sign'], body, sign('sign'), 'abc', NOW)).toBe('bad_signature');
    expect(verifySlack(['sign'], body, undefined, ts, NOW)).toBe('bad_signature');
  });

  it('refuses a replay older than five minutes even when the signature is valid', () => {
    const old = String(NOW / 1000 - 301);
    expect(verifySlack(['sign'], body, sign('sign', old), old, NOW)).toBe('stale');
    const edge = String(NOW / 1000 - 299);
    expect(verifySlack(['sign'], body, sign('sign', edge), edge, NOW)).toBe('ok');
  });
});

describe('verifySentry', () => {
  const parsed = { action: 'created', installation: { uuid: 'u1' } };
  const raw = Buffer.from(JSON.stringify(parsed, null, 1));

  it('accepts the HMAC of the raw body or of the compact JSON', () => {
    expect(verifySentry(['cs'], raw, hex('cs', raw), parsed)).toBe('ok');
    expect(verifySentry(['cs'], raw, hex('cs', JSON.stringify(parsed)), parsed)).toBe('ok');
  });

  it('refuses a wrong secret or a missing signature', () => {
    expect(verifySentry(['cs'], raw, hex('x', raw), parsed)).toBe('bad_signature');
    expect(verifySentry(['cs'], raw, undefined, parsed)).toBe('bad_signature');
  });
});

describe('verifyFigma', () => {
  it('compares the payload passcode with the stored one', () => {
    expect(verifyFigma(['pass'], 'pass')).toBe('ok');
    expect(verifyFigma(['pass'], 'pas')).toBe('bad_signature');
    expect(verifyFigma(['pass'], undefined)).toBe('bad_signature');
    expect(verifyFigma([], 'pass')).toBe('bad_signature');
  });
});
