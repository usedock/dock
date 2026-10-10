import { BetterAuthService } from './better-auth.service';

function build(env: Record<string, string>) {
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      if (env[key] === undefined) throw new Error(`missing ${key}`);
      return env[key];
    },
  };
  return new BetterAuthService({} as never, config as never, {} as never, {} as never);
}

const SECRET = { BETTER_AUTH_SECRET: 's'.repeat(32) };

describe('BetterAuthService', () => {
  it('keeps hosted defaults: usedock origins, api base, shared parent cookie in production', () => {
    const service = build({ ...SECRET, NODE_ENV: 'production' });
    expect(service.trustedOrigins).toEqual(expect.arrayContaining(['https://dashboard.usedock.io', 'https://usedock.io']));
    expect(service.auth.options.baseURL).toBe('https://api.usedock.io');
    expect(service.auth.options.advanced?.crossSubDomainCookies).toEqual({ enabled: true, domain: '.usedock.io' });
    expect(service.auth.options.socialProviders).toEqual({});
  });

  it('sends a verification email on sign-up without requiring it to sign in', () => {
    const options = build({ ...SECRET }).auth.options;
    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailAndPassword?.requireEmailVerification).toBeUndefined();
  });

  it('derives a self-hosted base, origins, and single-host cookies from PUBLIC_* URLs', () => {
    const service = build({
      ...SECRET,
      NODE_ENV: 'production',
      PUBLIC_API_URL: 'https://dock.example.com',
      PUBLIC_APP_URL: 'https://dock.example.com',
    });
    expect(service.auth.options.baseURL).toBe('https://dock.example.com');
    expect(service.trustedOrigins).toContain('https://dock.example.com');
    expect(service.trustedOrigins.join(',')).not.toContain('usedock.io');
    expect(service.auth.options.advanced?.crossSubDomainCookies).toBeUndefined();
  });

  it('prefers an explicit BETTER_AUTH_URL and enables only fully configured providers', () => {
    const service = build({
      ...SECRET,
      BETTER_AUTH_URL: 'http://localhost:8000',
      BETTER_AUTH_GITHUB_CLIENT_ID: 'id',
      BETTER_AUTH_GITHUB_CLIENT_SECRET: 'secret',
      BETTER_AUTH_GOOGLE_CLIENT_ID: 'id-only',
    });
    expect(service.auth.options.baseURL).toBe('http://localhost:8000');
    expect(Object.keys(service.auth.options.socialProviders ?? {})).toEqual(['github']);
    expect(service.auth.options.account?.accountLinking?.allowDifferentEmails).toBe(true);
  });
});
