import { assertPublicSentryHost, normalizeSentryHost } from './connector-host';

describe('normalizeSentryHost', () => {
  it('treats sentry.io as the default and keeps regions and self-hosted origins', () => {
    expect(normalizeSentryHost('sentry.io')).toBeNull();
    expect(normalizeSentryHost('https://sentry.io/')).toBeNull();
    expect(normalizeSentryHost('de.sentry.io')).toBe('https://de.sentry.io');
    expect(normalizeSentryHost('https://Sentry.Example.com:9000')).toBe('https://sentry.example.com:9000');
  });

  it('refuses plain http, credentials, paths and local names', () => {
    for (const bad of ['http://sentry.example.com', 'https://u:p@sentry.example.com', 'https://sentry.example.com/api', 'https://sentry.example.com?x=1', 'localhost', 'sentry', 'box.internal', 'https://sentry.io:8443']) {
      expect(() => normalizeSentryHost(bad), bad).toThrow();
    }
  });
});

describe('assertPublicSentryHost', () => {
  it('lets SaaS regions through without DNS', async () => {
    const resolve = vi.fn();
    await assertPublicSentryHost(null, resolve);
    await assertPublicSentryHost('https://de.sentry.io', resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a self-hosted name that resolves privately and an IP literal in a private range', async () => {
    await expect(assertPublicSentryHost('https://sentry.example.com', async () => ['10.0.0.5'])).rejects.toMatchObject({ response: { code: 'connector_host_invalid' } });
    await expect(assertPublicSentryHost('https://sentry.example.com', async () => ['93.184.216.34', '127.0.0.1'])).rejects.toThrow();
    await expect(assertPublicSentryHost('https://169.254.169.254')).rejects.toThrow();
    await expect(assertPublicSentryHost('https://sentry.example.com', async () => [])).rejects.toThrow();
  });

  it('accepts a self-hosted name that resolves publicly', async () => {
    await expect(assertPublicSentryHost('https://sentry.example.com', async () => ['93.184.216.34'])).resolves.toBeUndefined();
  });
});
