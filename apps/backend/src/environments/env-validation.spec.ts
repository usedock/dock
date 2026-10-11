import { HttpException } from '@nestjs/common';
import {
  assertEnvKey,
  assertEnvMap,
  assertSecretPath,
  checkedEgressAllow,
  parseEnvContents,
  serializeEnvContents,
} from './env-validation';

function errOf(fn: () => unknown): { status: number; body: unknown } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('expected rejection');
}

describe('parseEnvContents', () => {
  it('parses KEY=value lines, skipping blanks and comments', () => {
    expect(parseEnvContents('A=1\n\n# note\nB=2\n')).toEqual({ A: '1', B: '2' });
  });

  it('keeps = inside values and lets last duplicate win', () => {
    expect(parseEnvContents('A=1\nA=x=y\n')).toEqual({ A: 'x=y' });
  });

  it('rejects lines without = and reserved names', () => {
    expect(errOf(() => parseEnvContents('NOEQUALS')).body).toMatchObject({ code: 'validation_error' });
    expect(errOf(() => parseEnvContents('DOCK_ID=evil')).body).toMatchObject({ code: 'validation_error' });
    expect(errOf(() => parseEnvContents('DOCK_ANYTHING=evil')).body).toMatchObject({ code: 'validation_error' });
  });

  it('round-trips through serialize', () => {
    expect(parseEnvContents(serializeEnvContents({ A: '1', B: 'x=y' }))).toEqual({ A: '1', B: 'x=y' });
    expect(serializeEnvContents({})).toBe('');
  });
});

describe('assertEnvKey', () => {
  it.each(['STRIPE_KEY', '_x', 'a1'])('accepts %s', (key) => {
    expect(() => assertEnvKey(key)).not.toThrow();
  });

  it.each(['1abc', 'has-dash', 'has space', 'BOX_ID', 'ASCII_TOKEN', 'a'.repeat(129)])('rejects %s', (key) => {
    expect(errOf(() => assertEnvKey(key)).body).toMatchObject({ code: 'validation_error' });
  });
});

describe('assertEnvMap', () => {
  it('rejects over 100 variables and over 64KB total', () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, 'v']));
    expect(errOf(() => assertEnvMap(many)).body).toMatchObject({ code: 'validation_error' });
    expect(errOf(() => assertEnvMap({ BIG: 'x'.repeat(65536) })).body).toMatchObject({ code: 'validation_error' });
  });
});

describe('assertSecretPath', () => {
  it.each(['backend/.env', 'hello-world/backend/.env', '.env'])('accepts %s', (path) => {
    expect(() => assertSecretPath(path)).not.toThrow();
  });

  it.each(['/abs/path', '../escape', 'a/../../b', 'a//b', '', 'back\\slash'])('rejects %s', (path) => {
    expect(errOf(() => assertSecretPath(path)).body).toMatchObject({ code: 'validation_error' });
  });
});

describe('checkedEgressAllow', () => {
  it('passes null through and normalizes hostnames and wildcards', () => {
    expect(checkedEgressAllow(null)).toBeNull();
    expect(checkedEgressAllow([' API.GitHub.com ', '*.npmjs.org', 'api.github.com'])).toEqual(['api.github.com', '*.npmjs.org']);
  });

  it('rejects empty lists, IPs, schemes, ports, bare wildcards and non-lists', () => {
    for (const bad of [[], ['10.0.0.1'], ['1.2.3.4'], ['https://example.com'], ['example.com:443'], ['example.com/x'], ['*.com'], ['*'], ['localhost'], [''], [5], 'example.com', ['a_b.example.com']]) {
      expect(errOf(() => checkedEgressAllow(bad)).status).toBe(400);
    }
  });

  it('caps entry count and length', () => {
    const many = Array.from({ length: 51 }, (_, i) => `h${i}.example.com`);
    expect(errOf(() => checkedEgressAllow(many)).status).toBe(400);
    expect(errOf(() => checkedEgressAllow([`${'a'.repeat(64)}.example.com`])).status).toBe(400);
  });
});
