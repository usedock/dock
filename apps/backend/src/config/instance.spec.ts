import {
  authCookieDomain,
  authTrustedOrigins,
  instanceSummary,
  portsDomain,
  sshEndpoint,
  isInstanceAdmin,
  mailDelivery,
  oauthProviders,
  publicApiUrl,
  publicAppUrl,
} from './instance';

const reader = (env: Record<string, string>) => ({ get: <T>(key: string) => env[key] as T | undefined });

describe('instance config', () => {
  it('matches instance admins case-insensitively and has none when unset', () => {
    const config = reader({ INSTANCE_ADMIN_EMAILS: ' Ops@Example.com , second@example.com' });
    const verified = (email: string) => ({ email, emailVerified: true });
    expect(isInstanceAdmin(config, verified('ops@example.com '))).toBe(true);
    expect(isInstanceAdmin(config, verified('second@example.com'))).toBe(true);
    expect(isInstanceAdmin(config, verified('member@example.com'))).toBe(false);
    expect(isInstanceAdmin(reader({}), verified('ops@example.com'))).toBe(false);
  });

  it('never grants instance admin to an unverified or unknown-verification email', () => {
    const config = reader({ INSTANCE_ADMIN_EMAILS: 'ops@example.com' });
    expect(isInstanceAdmin(config, { email: 'ops@example.com', emailVerified: false })).toBe(false);
    expect(isInstanceAdmin(config, { email: 'ops@example.com' })).toBe(false);
  });

  it('defaults every public URL to the hosted cloud', () => {
    const config = reader({});
    expect(publicApiUrl(config)).toBe('https://api.usedock.io');
    expect(publicAppUrl(config)).toBe('https://dashboard.usedock.io');
    expect(authCookieDomain(config)).toBe('.usedock.io');
    expect(authTrustedOrigins(config).sort()).toEqual(
      [
        'http://localhost:3000',
        'http://localhost:3002',
        'http://localhost:3003',
        'https://usedock.io',
        'https://dashboard.usedock.io',
      ].sort(),
    );
  });

  it('trusts localhost origins only outside production', () => {
    expect(authTrustedOrigins(reader({ NODE_ENV: 'development' }))).toContain('http://localhost:3000');
    const prod = authTrustedOrigins(reader({ NODE_ENV: 'production' }));
    expect(prod.some((o) => o.includes('localhost'))).toBe(false);
    expect(prod).toContain('https://dashboard.usedock.io');
  });

  it('derives self-hosted URLs, origins, and cookie domain from PUBLIC_* only', () => {
    const config = reader({ PUBLIC_API_URL: 'https://api.dock.example.com/', PUBLIC_APP_URL: 'https://dock.example.com' });
    expect(publicApiUrl(config)).toBe('https://api.dock.example.com');
    expect(authCookieDomain(config)).toBe('.dock.example.com');
    const origins = authTrustedOrigins(config);
    expect(origins).toContain('https://dock.example.com');
    expect(origins.some((o) => o.includes('usedock.io'))).toBe(false);
  });

  it('adds explicit trusted origins and honors an explicit cookie domain', () => {
    const config = reader({
      PUBLIC_APP_URL: 'https://dock.example.com',
      AUTH_TRUSTED_ORIGINS: 'https://www.example.com/, https://docs.example.com',
      AUTH_COOKIE_DOMAIN: '',
    });
    expect(authTrustedOrigins(config)).toEqual(expect.arrayContaining(['https://www.example.com', 'https://docs.example.com']));
    expect(authCookieDomain(config)).toBeNull();
  });

  it.each([
    ['https://dock.example.com', 'https://dock.example.com'],
    ['http://10.0.0.5:3002', 'http://10.0.0.5:8000'],
    ['https://dock.one.dev', 'https://api.other.dev'],
    ['http://localhost:3002', 'http://localhost:8000'],
  ])('shares no cookie domain between %s and %s', (app, api) => {
    expect(authCookieDomain(reader({ PUBLIC_APP_URL: app, PUBLIC_API_URL: api }))).toBeNull();
  });

  it('enables a social provider only when both id and secret are set', () => {
    expect(oauthProviders(reader({}))).toEqual([]);
    expect(oauthProviders(reader({ BETTER_AUTH_GOOGLE_CLIENT_ID: 'id' }))).toEqual([]);
    expect(
      oauthProviders(
        reader({
          BETTER_AUTH_GOOGLE_CLIENT_ID: 'id',
          BETTER_AUTH_GOOGLE_CLIENT_SECRET: 's',
          BETTER_AUTH_GITHUB_CLIENT_ID: 'id',
          BETTER_AUTH_GITHUB_CLIENT_SECRET: 's',
        }),
      ),
    ).toEqual(['google', 'github']);
  });

  it('summarizes billing, mail, and GitHub App state without secrets', () => {
    const summary = instanceSummary(
      reader({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem', PUBLIC_API_URL: 'https://api.x.dev' }),
    );
    expect(summary).toEqual({
      apiUrl: 'https://api.x.dev',
      appUrl: 'https://dashboard.usedock.io',
      billingEnabled: false,
      authProviders: [],
      mailDelivery: 'log',
      githubAppConfigured: true,
      ssh: null,
      ports: null,
      chatgptSignIn: false,
    });
    expect(JSON.stringify(summary)).not.toContain('pem');
    expect(instanceSummary(reader({ CHATGPT_SIGNIN_ENABLED: 'true' })).chatgptSignIn).toBe(true);
    expect(mailDelivery(reader({ SMTP_HOST: 'smtp.example.com' }))).toBe('smtp');
  });

  it('reports the SSH endpoint only when the gateway listens', () => {
    expect(sshEndpoint(reader({}))).toBeNull();
    expect(sshEndpoint(reader({ SSH_GATEWAY_PORT: '2222' }))).toEqual({ host: 'api.usedock.io', port: 2222 });
    expect(sshEndpoint(reader({ SSH_GATEWAY_PORT: '2222', SSH_PUBLIC_HOST: 'ssh.x.dev', SSH_PUBLIC_PORT: '22' }))).toEqual({ host: 'ssh.x.dev', port: 22 });
  });

  it('reports the ports domain only when the proxy listens', () => {
    expect(portsDomain(reader({ PORTS_DOMAIN: 'ports.x.dev' }))).toBeNull();
    expect(portsDomain(reader({ PORTS_DOMAIN: 'ports.x.dev', PORTS_PROXY_PORT: '8001' }))).toBe('ports.x.dev');
    expect(instanceSummary(reader({ PORTS_DOMAIN: 'ports.x.dev', PORTS_PROXY_PORT: '8001' })).ports).toEqual({ domain: 'ports.x.dev' });
  });
});
