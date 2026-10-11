import { z } from 'zod';
import { authCookieDomain } from './instance';

function optionalUrl(name: string) {
  return z.union([z.string().url(`${name} must be a URL`), z.literal('')]).optional();
}

/** Blank reads as unset so `.env` templates can leave a value empty. */
function blankAsUnset(v: unknown): unknown {
  return v === '' ? undefined : v;
}

/** Blank reads as unset so `.env` templates can leave ports empty. */
function optionalPort() {
  return z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).optional());
}

const envSchema = z
  .object({
    DATABASE_URL: z.string().url('DATABASE_URL must be a URL'),
    TEST_DATABASE_URL: z.string().url('TEST_DATABASE_URL must be a URL').optional(),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    PORT: z.coerce.number().int().positive().default(8000),
    /** Public API base, e.g. https://api.example.com; defaults to the hosted cloud. */
    PUBLIC_API_URL: optionalUrl('PUBLIC_API_URL'),
    /** Public dashboard base, e.g. https://dock.example.com; defaults to the hosted cloud. */
    PUBLIC_APP_URL: optionalUrl('PUBLIC_APP_URL'),
    /** Legacy dashboard link base for notifications; falls back to PUBLIC_APP_URL. */
    APP_URL: optionalUrl('APP_URL'),
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
    /** Legacy auth base; falls back to PUBLIC_API_URL. */
    BETTER_AUTH_URL: optionalUrl('BETTER_AUTH_URL'),
    /** Extra comma-separated origins trusted by auth besides PUBLIC_APP_URL. */
    AUTH_TRUSTED_ORIGINS: z.string().optional(),
    /** Cross-subdomain auth cookie domain; empty disables, unset derives from the public hosts. */
    AUTH_COOKIE_DOMAIN: z.string().optional(),
    // Social sign-in: each provider is enabled only when both its id and secret are set.
    BETTER_AUTH_GOOGLE_CLIENT_ID: z.string().optional().default(''),
    BETTER_AUTH_GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
    BETTER_AUTH_GITHUB_CLIENT_ID: z.string().optional().default(''),
    BETTER_AUTH_GITHUB_CLIENT_SECRET: z.string().optional().default(''),
    /** Legacy GitHub callback base for runs; falls back to PUBLIC_API_URL. */
    GITHUB_CALLBACK_BASE_URL: optionalUrl('GITHUB_CALLBACK_BASE_URL'),
    /** Comma-separated emails allowed to run instance setup such as GitHub App registration. */
    INSTANCE_ADMIN_EMAILS: z.string().optional().default(''),
    GITHUB_APP_ID: z.string().optional().default(''),
    GITHUB_APP_SLUG: z.string().optional().default('dock'),
    GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
    GITHUB_APP_PRIVATE_KEY_PREV: z.string().optional().default(''),
    GITHUB_APP_WEBHOOK_SECRET: z.string().optional().default(''),
    GITHUB_APP_CLIENT_ID: z.string().optional().default(''),
    GITHUB_APP_CLIENT_SECRET: z.string().optional().default(''),
    // Empty SMTP_HOST logs mail instead of delivering it (self-host and dev).
    SMTP_HOST: z.string().optional().default(''),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_USER: z.string().optional().default(''),
    SMTP_PASS: z.string().optional().default(''),
    SMTP_FROM: z.string().min(1, 'SMTP_FROM must not be empty').default('Dock <dock@localhost>'),
    // Where the marketing contact form delivers; replies go back to the visitor.
    CONTACT_INBOX: z.string().email('CONTACT_INBOX must be an email address').default('hello@usedock.io'),
    SECRETS_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'SECRETS_ENCRYPTION_KEY must be 32 bytes as 64 hex characters'),
    RUNTIME_DRIVER: z.enum(['fake', 'restate']).default('fake'),
    FAST_RUN_ENABLED: z.enum(['true', 'false']).default('false'),
    /** opencode model for GitHub runs, e.g. `anthropic/claude-sonnet-5`; empty picks one from the provider key. */
    GITHUB_RUN_MODEL: z.string().optional().default(''),
    /** Comma-separated HTTPS hosts confined runs may reach besides the control plane; `*` leaves egress open. */
    RUN_EGRESS_ALLOW: z.string().optional().default(''),
    // Connector OAuth: each tool is enabled only when both its id and secret are set.
    FIGMA_CLIENT_ID: z.string().optional().default(''),
    FIGMA_CLIENT_SECRET: z.string().optional().default(''),
    LINEAR_CLIENT_ID: z.string().optional().default(''),
    LINEAR_CLIENT_SECRET: z.string().optional().default(''),
    SLACK_CLIENT_ID: z.string().optional().default(''),
    SLACK_CLIENT_SECRET: z.string().optional().default(''),
    SENTRY_CLIENT_ID: z.string().optional().default(''),
    SENTRY_CLIENT_SECRET: z.string().optional().default(''),
    // Connector triggers: app-level secrets for Linear and Slack apps; Sentry and Figma secrets are stored per connector.
    LINEAR_WEBHOOK_SECRET: z.string().optional().default(''),
    SLACK_SIGNING_SECRET: z.string().optional().default(''),
    /** Agent that connector runs start in the dock (opencode or codex); its environment must install it. */
    CONNECTOR_RUN_AGENT: z.enum(['opencode', 'codex', '']).default('opencode'),
    /** Model for connector runs, passed to the agent as is; empty uses the agent default. */
    CONNECTOR_RUN_MODEL: z.string().optional().default(''),
    /** Most connector runs a workspace may have in flight; further events get a busy reply. */
    CONNECTOR_RUN_MAX_CONCURRENT: z.string().regex(/^[0-9]*$/).optional().default('5'),
    /** Non-secret setup that installs the run agent in connector docks, which receive no environment. */
    CONNECTOR_RUN_SETUP_SCRIPT: z.string().optional().default(''),
    CONNECTOR_RUN_TIMEOUT_MINUTES: z.string().regex(/^[0-9]*$/).optional().default('30'),
    /** Personal ChatGPT subscription sign-in for runs; unofficial (Codex client), so off unless opted in. */
    CHATGPT_SIGNIN_ENABLED: z.enum(['true', 'false']).default('false'),
    RESTATE_INGRESS_URL: z.string().url('RESTATE_INGRESS_URL must be a URL').optional(),
    DOCKLET_BASE_URL: z.string().url('DOCKLET_BASE_URL must be a URL').optional(),
    /** Shared bearer token hosts present on every fleet call. */
    FLEET_TOKEN: z.string().min(16, 'FLEET_TOKEN must be at least 16 characters').optional(),
    FLEET_POLL_WAIT_SECONDS: z.string().optional(),
    // Transition only: accept the shared token for hosts that have no credential yet.
    FLEET_LEGACY_SHARED_TOKEN: z.enum(['true', 'false']).optional(),
    /** Bearer token for the docklet's local API; must match the docklet's DOCKLET_LOCAL_TOKEN. */
    DOCKLET_LOCAL_TOKEN: z.string().min(1, 'DOCKLET_LOCAL_TOKEN must not be empty').optional(),
    DOCKLET_CA_PATH: z.string().min(1, 'DOCKLET_CA_PATH must not be empty').optional(),
    DOCKLET_CERT_PATH: z.string().min(1, 'DOCKLET_CERT_PATH must not be empty').optional(),
    DOCKLET_KEY_PATH: z.string().min(1, 'DOCKLET_KEY_PATH must not be empty').optional(),
    SNAPSHOT_STORE_ENDPOINT: z.string().min(1, 'SNAPSHOT_STORE_ENDPOINT must not be empty').optional(),
    SNAPSHOT_STORE_BUCKET: z.string().min(1, 'SNAPSHOT_STORE_BUCKET must not be empty').optional(),
    SNAPSHOT_STORE_ACCESS_KEY: z.string().min(1, 'SNAPSHOT_STORE_ACCESS_KEY must not be empty').optional(),
    SNAPSHOT_STORE_SECRET_KEY: z.string().min(1, 'SNAPSHOT_STORE_SECRET_KEY must not be empty').optional(),
    // Host-reachable store address for presigned transfers; empty reuses the endpoint above.
    SNAPSHOT_STORE_PUBLIC_ENDPOINT: z
      .union([z.string().min(1, 'SNAPSHOT_STORE_PUBLIC_ENDPOINT must not be empty'), z.literal('')])
      .optional(),
    SNAPSHOT_STORE_REGION: z.string().min(1, 'SNAPSHOT_STORE_REGION must not be empty').optional(),
    SNAPSHOT_STORE_PATH_STYLE: z.enum(['true', 'false']).optional(),
    SNAPSHOT_STORE_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().optional(),
    /** SSH gateway listen port; unset disables SSH. */
    SSH_GATEWAY_PORT: optionalPort(),
    /** OpenSSH private host key (`\n` escapes allowed); unset derives a stable key from BETTER_AUTH_SECRET. */
    SSH_HOST_KEY: z.string().optional().default(''),
    /** Host and port users connect to; default to the API host and SSH_GATEWAY_PORT. */
    SSH_PUBLIC_HOST: z.string().optional().default(''),
    SSH_PUBLIC_PORT: optionalPort(),
    /** Parent domain of exposed port URLs (`<label>.<PORTS_DOMAIN>`); ports are off unless this and PORTS_PROXY_PORT are set. */
    PORTS_DOMAIN: z
      .string()
      .optional()
      .default('')
      .refine((v) => v === '' || /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(v), 'PORTS_DOMAIN must be a lowercase domain name'),
    /** Plain-TCP listener the edge proxy forwards port hostnames to, with upstream keep-alive off. */
    PORTS_PROXY_PORT: optionalPort(),
    /** Key for the edge-to-proxy port proof; unset derives a subkey of BETTER_AUTH_SECRET. */
    DOCK_PORT_PROOF_SECRET: z.string().optional().default(''),
    SENTRY_DSN: z
      .union([z.string().url('SENTRY_DSN must be a URL'), z.literal('')])
      .optional()
      .default(''),
    SENTRY_ENVIRONMENT: z.string().min(1, 'SENTRY_ENVIRONMENT must not be empty').max(64).optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    SENTRY_ENABLED: z.enum(['true', 'false']).optional().default('true'),
    /** Anonymous usage counts (see the telemetry docs page); nothing is sent unless `on`. */
    DOCK_TELEMETRY: z.preprocess(blankAsUnset, z.enum(['on', 'off']).default('off')),
    DOCK_TELEMETRY_URL: z.preprocess(
      blankAsUnset,
      z.string().url('DOCK_TELEMETRY_URL must be a URL').default('https://api.usedock.io/v1/telemetry'),
    ),
  })
  .superRefine((env, ctx) => {
    // One public URL without the other would mix a self-hosted host with the hosted cloud.
    if (Boolean(env.PUBLIC_API_URL) !== Boolean(env.PUBLIC_APP_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [env.PUBLIC_API_URL ? 'PUBLIC_APP_URL' : 'PUBLIC_API_URL'],
        message: 'PUBLIC_API_URL and PUBLIC_APP_URL must be set together',
      });
    }
    // Port URLs serve user code; under the auth cookie domain they would receive session cookies.
    const cookieDomain = env.PORTS_DOMAIN ? authCookieDomain({ get: <T>(key: string) => (env as Record<string, unknown>)[key] as T }) : null;
    if (cookieDomain && `.${env.PORTS_DOMAIN}`.endsWith(cookieDomain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PORTS_DOMAIN'],
        message: `PORTS_DOMAIN must not be under the auth cookie domain ${cookieDomain}; use a separate domain`,
      });
    }
    if (process.env.NODE_ENV === 'test' && !env.TEST_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TEST_DATABASE_URL'],
        message: 'TEST_DATABASE_URL is required when NODE_ENV=test',
      });
    }
    if (env.RUNTIME_DRIVER === 'restate') {
      if (!env.RESTATE_INGRESS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RESTATE_INGRESS_URL'],
          message: 'RESTATE_INGRESS_URL is required when RUNTIME_DRIVER=restate',
        });
      }
      // Hosts are addressed through the outbound command channel, so no
      // per-host base URL is required; the fleet token authenticates them.
      if (!env.FLEET_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FLEET_TOKEN'],
          message: 'FLEET_TOKEN is required when RUNTIME_DRIVER=restate',
        });
      }
      if (!env.SNAPSHOT_STORE_ENDPOINT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SNAPSHOT_STORE_ENDPOINT'],
          message: 'SNAPSHOT_STORE_ENDPOINT is required when RUNTIME_DRIVER=restate',
        });
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

/** Validates process env at boot; throws a field list so misconfig fails fast. */
export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n- ${fields.join('\n- ')}`);
  }
  return parsed.data;
}
