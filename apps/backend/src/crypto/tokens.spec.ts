import { createHash } from 'crypto';
import { base64url, hashToken, newToken, newUuid } from './tokens';

describe('newToken', () => {
  it('returns unique 64-char hex strings', () => {
    const a = newToken();
    const b = newToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  it('is deterministic and matches sha256 reference', () => {
    const token = newToken();
    const expected = createHash('sha256').update(token).digest('hex');
    expect(hashToken(token)).toBe(expected);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs and never equals the raw token', () => {
    const a = newToken();
    const b = newToken();
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(hashToken(a)).not.toBe(a);
  });
});

describe('base64url', () => {
  it('strips + / = and round-trips', () => {
    const out = base64url(Buffer.from([0xfb, 0xff]));
    expect(out).not.toMatch(/[+/=]/);
    expect(Buffer.from(out, 'base64url')).toEqual(Buffer.from([0xfb, 0xff]));
  });

  it('returns empty string for empty buffer', () => {
    expect(base64url(Buffer.from([]))).toBe('');
  });
});

describe('newUuid', () => {
  it('returns unique v4 uuids', () => {
    const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = newUuid();
    const b = newUuid();
    expect(a).toMatch(shape);
    expect(b).toMatch(shape);
    expect(a).not.toBe(b);
  });
});
