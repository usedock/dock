import { readFileSync } from 'fs';
import { join } from 'path';
import type { ErrorEvent } from '@sentry/nestjs';
import {
  resolveSentryEnvironment,
  resolveTracesSampleRate,
  scrubSentryEvent,
  shouldEnableSentry,
} from './sentry-options';

function piiEvent(): ErrorEvent {
  return {
    user: { id: 'u1', email: 'ann@example.com', username: 'ann', ip_address: '1.2.3.4' },
    request: {
      url: 'http://localhost:8000/v1/docks?token=abc&code=def',
      method: 'GET',
      headers: {
        authorization: 'Bearer abc',
        cookie: 'session=1',
        'x-request-id': 'cid-1',
        host: 'localhost:8000',
      },
      cookies: { session: '1' },
      query_string: 'token=abc&code=def',
      data: {
        name: 'dock',
        email: 'ann@example.com',
        password: 'supersecret',
        nested: { apiKey: 'k', safe: 'keep' },
        list: [{ secret: 's' }],
      },
    },
  } as unknown as ErrorEvent;
}

describe('shouldEnableSentry', () => {
  it('stays off without a DSN and never throws', () => {
    expect(shouldEnableSentry({})).toBe(false);
    expect(shouldEnableSentry({ SENTRY_DSN: '' })).toBe(false);
    expect(() => shouldEnableSentry({ SENTRY_DSN: ':::not-a-url' })).not.toThrow();
  });

  it('turns on with a well-formed DSN', () => {
    expect(shouldEnableSentry({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1' })).toBe(true);
  });

  it('stays off for malformed or non-http DSNs', () => {
    expect(shouldEnableSentry({ SENTRY_DSN: 'not-a-url' })).toBe(false);
    expect(shouldEnableSentry({ SENTRY_DSN: 'ftp://key@host/1' })).toBe(false);
  });

  it('honors the SENTRY_ENABLED=false kill-switch even with a DSN', () => {
    expect(
      shouldEnableSentry({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1', SENTRY_ENABLED: 'false' }),
    ).toBe(false);
  });
});

describe('resolveSentryEnvironment', () => {
  it('prefers SENTRY_ENVIRONMENT, then NODE_ENV, then development', () => {
    expect(resolveSentryEnvironment({ SENTRY_ENVIRONMENT: 'staging', NODE_ENV: 'prod' })).toBe('staging');
    expect(resolveSentryEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(resolveSentryEnvironment({})).toBe('development');
  });
});

describe('resolveTracesSampleRate', () => {
  it('parses, clamps, and defaults unparseable input to 0', () => {
    expect(resolveTracesSampleRate('0.1')).toBe(0.1);
    expect(resolveTracesSampleRate(2)).toBe(1);
    expect(resolveTracesSampleRate(-1)).toBe(0);
    expect(resolveTracesSampleRate('junk')).toBe(0);
    expect(resolveTracesSampleRate(undefined)).toBe(0);
  });
});

describe('scrubSentryEvent', () => {
  it('drops PII while preserving route, user id, and safe fields', () => {
    const out = scrubSentryEvent(piiEvent());
    expect(out.user).toEqual({ id: 'u1' });
    expect(out.request!.url).toBe('http://localhost:8000/v1/docks');
    expect(out.request!.query_string).toBeUndefined();
    expect(out.request!.cookies).toBeUndefined();
    expect(out.request!.headers).toEqual({ 'x-request-id': 'cid-1', host: 'localhost:8000' });
    expect(out.request!.data).toEqual({
      name: 'dock',
      email: '[Filtered]',
      password: '[Filtered]',
      nested: { apiKey: '[Filtered]', safe: 'keep' },
      list: [{ secret: '[Filtered]' }],
    });
  });

  it('tolerates events without user or request', () => {
    expect(() => scrubSentryEvent({} as ErrorEvent)).not.toThrow();
    expect(scrubSentryEvent({} as ErrorEvent)).toEqual({});
  });
});

describe('instrument import order', () => {
  it('imports ./instrument before any other import in main.ts', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'main.ts'), 'utf8');
    const imports = main.split('\n').filter((line) => line.startsWith('import '));
    expect(imports[0]).toBe("import './instrument';");
  });
});
