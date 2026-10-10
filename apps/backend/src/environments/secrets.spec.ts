import { HttpException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SecretsUnavailableException, openValue, sealValue } from './secrets';

const key = Buffer.alloc(32, 7);

describe('secrets', () => {
  it('round-trips a sealed value', () => {
    expect(openValue(key, sealValue(key, 'postgres://secret'))).toBe('postgres://secret');
  });

  it('seals the same plaintext to different envelopes', () => {
    expect(sealValue(key, 'same').data).not.toBe(sealValue(key, 'same').data);
  });

  it('fails closed on the wrong key', () => {
    const sealed = sealValue(key, 'value');
    try {
      openValue(randomBytes(32), sealed);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(503);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'service_unavailable' });
      return;
    }
    throw new Error('expected rejection');
  });

  it('fails closed on tampered data', () => {
    const sealed = sealValue(key, 'value');
    expect(() =>
      openValue(key, { ...sealed, data: Buffer.from('tampered').toString('base64') }),
    ).toThrow(SecretsUnavailableException);
  });
});
