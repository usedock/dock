import { validateEnv } from './validate-env';

function validEnv(): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    TEST_DATABASE_URL: 'postgres://user:pass@localhost:5432/db_test',
    REDIS_URL: 'redis://localhost:6379',
    APP_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:8000',
    SMTP_HOST: 'localhost',
    SMTP_FROM: 'noreply@example.com',
    SECRETS_ENCRYPTION_KEY: 'a'.repeat(64),
  };
}

describe('validateEnv github app', () => {
  it('defaults the App to unconfigured without failing the boot', () => {
    const env = validateEnv(validEnv());
    expect(env.GITHUB_APP_ID).toBe('');
    expect(env.GITHUB_APP_SLUG).toBe('dock');
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe('');
    expect(env.GITHUB_APP_WEBHOOK_SECRET).toBe('');
  });

  it('accepts a fully configured App', () => {
    const env = validateEnv({
      ...validEnv(),
      GITHUB_APP_ID: '12345',
      GITHUB_APP_SLUG: 'dock',
      GITHUB_APP_PRIVATE_KEY: 'pem-body',
      GITHUB_APP_WEBHOOK_SECRET: 'whsec',
    });
    expect(env.GITHUB_APP_ID).toBe('12345');
    expect(env.GITHUB_APP_WEBHOOK_SECRET).toBe('whsec');
  });
});
