import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('validateEnv', () => {
  it('returns parsed env with defaults applied for valid input', () => {
    const env = validateEnv(validEnv());
    expect(env.PORT).toBe(8000);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_USER).toBe('');
    expect(env.SMTP_PASS).toBe('');
    expect(env.CONTACT_INBOX).toBe('hello@usedock.io');
    expect(env.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/db');
  });

  it('rejects a malformed CONTACT_INBOX naming the field', () => {
    expect(() => validateEnv({ ...validEnv(), CONTACT_INBOX: 'not-an-email' })).toThrow(
      /CONTACT_INBOX/,
    );
  });


  it.each([
    ['DATABASE_URL', 'not-a-url'],
    ['APP_URL', 'not-a-url'],
  ])('rejects bad %s naming the field', (field, value) => {
    expect(() => validateEnv({ ...validEnv(), [field]: value })).toThrow(
      new RegExp(field),
    );
  });

  it('lists multiple field names when keys are missing', () => {
    let message = '';
    try {
      validateEnv({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Invalid environment configuration:/);
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('BETTER_AUTH_SECRET');
    expect(message).toContain('SECRETS_ENCRYPTION_KEY');
  });

  it('boots a self-hosted instance without OAuth, SMTP, or public URLs', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      TEST_DATABASE_URL: 'postgres://user:pass@localhost:5432/db_test',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'b'.repeat(32),
      SECRETS_ENCRYPTION_KEY: 'a'.repeat(64),
    });
    expect(env.SMTP_HOST).toBe('');
    expect(env.SMTP_FROM).toBe('Dock <dock@localhost>');
    expect(env.BETTER_AUTH_GOOGLE_CLIENT_ID).toBe('');
    expect(env.PUBLIC_API_URL).toBeUndefined();
  });

  it.each(['PUBLIC_API_URL', 'PUBLIC_APP_URL', 'GITHUB_CALLBACK_BASE_URL'])('validates %s as a URL', (field) => {
    const both = { PUBLIC_API_URL: 'https://api.example.com', PUBLIC_APP_URL: 'https://dock.example.com' };
    expect(() => validateEnv({ ...validEnv(), ...both, [field]: 'nope' })).toThrow(new RegExp(field));
    expect(validateEnv({ ...validEnv(), ...both, [field]: 'https://x.example.com' })[field as 'PUBLIC_API_URL']).toBe(
      'https://x.example.com',
    );
  });

  it('validates PORTS_DOMAIN as a lowercase domain', () => {
    expect(validateEnv({ ...validEnv(), PORTS_DOMAIN: 'ports.example.dev', PORTS_PROXY_PORT: '8001' })).toMatchObject({
      PORTS_DOMAIN: 'ports.example.dev',
      PORTS_PROXY_PORT: 8001,
    });
    expect(() => validateEnv({ ...validEnv(), PORTS_DOMAIN: 'https://ports.example.dev' })).toThrow(/PORTS_DOMAIN/);
    expect(() => validateEnv({ ...validEnv(), PORTS_DOMAIN: 'Ports.Example.dev' })).toThrow(/PORTS_DOMAIN/);
  });

  it('accepts an empty or long DOCK_PORT_PROOF_SECRET and refuses a short one', () => {
    expect(validateEnv(validEnv()).DOCK_PORT_PROOF_SECRET).toBe('');
    expect(validateEnv({ ...validEnv(), DOCK_PORT_PROOF_SECRET: 'p'.repeat(32) }).DOCK_PORT_PROOF_SECRET).toBe('p'.repeat(32));
    expect(() => validateEnv({ ...validEnv(), DOCK_PORT_PROOF_SECRET: 'changeme' })).toThrow(/DOCK_PORT_PROOF_SECRET/);
  });

  it('refuses a PORTS_DOMAIN that would receive auth cookies', () => {
    const split = { PUBLIC_API_URL: 'https://api.example.com', PUBLIC_APP_URL: 'https://dock.example.com' };
    expect(() => validateEnv({ ...validEnv(), ...split, PORTS_DOMAIN: 'ports.example.com' })).toThrow(/auth cookie domain \.example\.com/);
    expect(() => validateEnv({ ...validEnv(), ...split, PORTS_DOMAIN: 'example.com' })).toThrow(/PORTS_DOMAIN/);
    expect(validateEnv({ ...validEnv(), ...split, PORTS_DOMAIN: 'example-ports.dev' }).PORTS_DOMAIN).toBe('example-ports.dev');
    const oneHost = { PUBLIC_API_URL: 'https://dock.example.com', PUBLIC_APP_URL: 'https://dock.example.com' };
    expect(validateEnv({ ...validEnv(), ...oneHost, PORTS_DOMAIN: 'ports.dock.example.com' }).PORTS_DOMAIN).toBe('ports.dock.example.com');
  });

  it('requires PUBLIC_API_URL and PUBLIC_APP_URL together', () => {
    expect(() => validateEnv({ ...validEnv(), PUBLIC_APP_URL: 'https://dock.example.com' })).toThrow(/PUBLIC_API_URL/);
    expect(() => validateEnv({ ...validEnv(), PUBLIC_API_URL: 'https://api.example.com' })).toThrow(/PUBLIC_APP_URL/);
  });


  it('requires TEST_DATABASE_URL when NODE_ENV is test', () => {
    expect(() => validateEnv((({ TEST_DATABASE_URL, ...rest }) => rest)(validEnv()))).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it('rejects a malformed TEST_DATABASE_URL when NODE_ENV is test', () => {
    expect(() => validateEnv({ ...validEnv(), TEST_DATABASE_URL: 'not-a-url' })).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it('ignores a missing TEST_DATABASE_URL outside test', () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const { TEST_DATABASE_URL, ...rest } = validEnv();
      expect(validateEnv(rest).DATABASE_URL).toBe('postgres://user:pass@localhost:5432/db');
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });
  it('defaults RUNTIME_DRIVER to fake with no runtime keys required', () => {
    const env = validateEnv(validEnv());
    expect(env.RUNTIME_DRIVER).toBe('fake');
    expect(env.FAST_RUN_ENABLED).toBe('false');
    expect(env.RESTATE_INGRESS_URL).toBeUndefined();
    expect(env.FLEET_TOKEN).toBeUndefined();
  });

  it('accepts explicit Fast Run rollout enablement', () => {
    expect(validateEnv({ ...validEnv(), FAST_RUN_ENABLED: 'true' }).FAST_RUN_ENABLED).toBe('true');
  });

  it('rejects an unknown RUNTIME_DRIVER naming the field', () => {
    expect(() => validateEnv({ ...validEnv(), RUNTIME_DRIVER: 'kubernetes' })).toThrow(
      /RUNTIME_DRIVER/,
    );
  });

  it('requires the ingress URL, fleet token, and snapshot store in restate mode', () => {
    let message = '';
    try {
      validateEnv({ ...validEnv(), RUNTIME_DRIVER: 'restate' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('RESTATE_INGRESS_URL');
    expect(message).toContain('FLEET_TOKEN');
    expect(message).toContain('SNAPSHOT_STORE_ENDPOINT');
  });

  it('does not require a per-host docklet URL, which the command channel replaces', () => {
    const env = validateEnv({
      ...validEnv(),
      RUNTIME_DRIVER: 'restate',
      RESTATE_INGRESS_URL: 'http://restate:8080',
      FLEET_TOKEN: 'fleet-token-at-least-16-chars',
      SNAPSHOT_STORE_ENDPOINT: 'http://minio:9000',
    });
    expect(env.RUNTIME_DRIVER).toBe('restate');
    expect(env.DOCKLET_BASE_URL).toBeUndefined();
  });

  it('rejects a fleet token too short to be a shared secret', () => {
    expect(() =>
      validateEnv({
        ...validEnv(),
        RUNTIME_DRIVER: 'restate',
        RESTATE_INGRESS_URL: 'http://restate:8080',
        FLEET_TOKEN: 'short',
        SNAPSHOT_STORE_ENDPOINT: 'http://minio:9000',
      }),
    ).toThrow(/FLEET_TOKEN/);
  });

  it('rejects a malformed SECRETS_ENCRYPTION_KEY naming the field', () => {
    expect(() => validateEnv({ ...validEnv(), SECRETS_ENCRYPTION_KEY: 'short' })).toThrow(
      /SECRETS_ENCRYPTION_KEY/,
    );
  });

  it('defaults Sentry to disabled with error-only sampling', () => {
    const env = validateEnv(validEnv());
    expect(env.SENTRY_DSN).toBe('');
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0);
    expect(env.SENTRY_ENABLED).toBe('true');
    expect(env.SENTRY_ENVIRONMENT).toBeUndefined();
  });

  it('accepts a full Sentry configuration', () => {
    const env = validateEnv({
      ...validEnv(),
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_TRACES_SAMPLE_RATE: '0.1',
      SENTRY_ENABLED: 'false',
    });
    expect(env.SENTRY_DSN).toBe('https://key@o1.ingest.sentry.io/1');
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0.1);
  });

  it('rejects a malformed SENTRY_DSN naming the field', () => {
    expect(() => validateEnv({ ...validEnv(), SENTRY_DSN: 'not-a-url' })).toThrow(/SENTRY_DSN/);
  });

  it('rejects an out-of-range SENTRY_TRACES_SAMPLE_RATE', () => {
    expect(() => validateEnv({ ...validEnv(), SENTRY_TRACES_SAMPLE_RATE: '2' })).toThrow(
      /SENTRY_TRACES_SAMPLE_RATE/,
    );
  });

  it('accepts .env.example once SECRETS_ENCRYPTION_KEY is filled in', () => {
    const env: Record<string, unknown> = {};
    for (const line of readFileSync(join(__dirname, '../../.env.example'), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
    expect(() => validateEnv({ ...env, SECRETS_ENCRYPTION_KEY: 'a'.repeat(64) })).not.toThrow();
  });
  it('defaults telemetry off and reads blank telemetry values as unset', () => {
    expect(validateEnv(validEnv())).toMatchObject({
      DOCK_TELEMETRY: 'off',
      DOCK_TELEMETRY_URL: 'https://api.usedock.io/v1/telemetry',
    });
    expect(validateEnv({ ...validEnv(), DOCK_TELEMETRY: '', DOCK_TELEMETRY_URL: '' })).toMatchObject({
      DOCK_TELEMETRY: 'off',
      DOCK_TELEMETRY_URL: 'https://api.usedock.io/v1/telemetry',
    });
  });

  it('rejects telemetry values other than on and off', () => {
    for (const value of ['ON', 'true', '1']) {
      expect(() => validateEnv({ ...validEnv(), DOCK_TELEMETRY: value })).toThrow(/DOCK_TELEMETRY/);
    }
    expect(validateEnv({ ...validEnv(), DOCK_TELEMETRY: 'on' }).DOCK_TELEMETRY).toBe('on');
  });
});
