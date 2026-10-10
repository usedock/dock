import { isIP } from 'node:net';

/** Read-only view of ConfigService; unset keys read as undefined. */
export interface ConfigReader {
  get<T = string>(key: string): T | undefined;
}

export const HOSTED_API_URL = 'https://api.usedock.io';
export const HOSTED_APP_URL = 'https://dashboard.usedock.io';
/** The hosted marketing site; trusted only while PUBLIC_APP_URL keeps its hosted default. */
const HOSTED_EXTRA_ORIGINS = ['https://usedock.io'];
const LOCAL_DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:3003'];

export type OAuthProvider = 'google' | 'github';
const OAUTH_PROVIDERS: OAuthProvider[] = ['google', 'github'];

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

function list(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The caller fields instance-admin checks need. */
export type AdminCandidate = { email: string; emailVerified?: boolean };

/** True when the email is in INSTANCE_ADMIN_EMAILS (case-insensitive) and verified; unknown verification fails closed. */
export function isInstanceAdmin(config: ConfigReader, user: AdminCandidate): boolean {
  if (user.emailVerified !== true) return false;
  const admins = list(config.get<string>('INSTANCE_ADMIN_EMAILS') ?? '').map((e) => e.toLowerCase());
  return admins.includes(user.email.trim().toLowerCase());
}

/** True when the email is listed as an admin but not (known to be) verified. */
export function isUnverifiedInstanceAdmin(config: ConfigReader, user: AdminCandidate): boolean {
  return user.emailVerified !== true && isInstanceAdmin(config, { ...user, emailVerified: true });
}

/** Public API base (no trailing slash): webhooks, callbacks, OpenAPI server, auth base. */
export function publicApiUrl(config: ConfigReader): string {
  return withoutTrailingSlash(config.get<string>('PUBLIC_API_URL') || HOSTED_API_URL);
}

/** Public dashboard base (no trailing slash). */
export function publicAppUrl(config: ConfigReader): string {
  return withoutTrailingSlash(config.get<string>('PUBLIC_APP_URL') || HOSTED_APP_URL);
}

/** Origins allowed to call backend-hosted auth with credentials. */
export function authTrustedOrigins(config: ConfigReader): string[] {
  const explicit = config.get<string>('AUTH_TRUSTED_ORIGINS');
  const extras =
    explicit !== undefined ? list(explicit) : config.get<string>('PUBLIC_APP_URL') ? [] : HOSTED_EXTRA_ORIGINS;
  const origins = [new URL(publicAppUrl(config)).origin, ...extras.map((o) => new URL(o).origin)];
  // Localhost is never a trusted origin in production.
  const local = config.get<string>('NODE_ENV') === 'production' ? [] : LOCAL_DEV_ORIGINS;
  return [...new Set([...local, ...origins])];
}

/**
 * Cookie domain shared by the dashboard and API hosts, e.g. `.usedock.io` for
 * dashboard.usedock.io + api.usedock.io; null when they share one host or no parent.
 */
export function authCookieDomain(config: ConfigReader): string | null {
  const explicit = config.get<string>('AUTH_COOKIE_DOMAIN');
  if (explicit !== undefined) return explicit || null;
  const app = new URL(publicAppUrl(config)).hostname;
  const api = new URL(publicApiUrl(config)).hostname;
  if (app === api || isIP(app) || isIP(api)) return null;
  const a = app.split('.').reverse();
  const b = api.split('.').reverse();
  const shared: string[] = [];
  while (shared.length < a.length && a[shared.length] === b[shared.length]) shared.push(a[shared.length]);
  return shared.length >= 2 ? `.${shared.reverse().join('.')}` : null;
}

/** Social sign-in providers with both a client id and secret configured. */
export function oauthProviders(config: ConfigReader): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((p) => {
    const key = `BETTER_AUTH_${p.toUpperCase()}_CLIENT`;
    return Boolean(config.get<string>(`${key}_ID`) && config.get<string>(`${key}_SECRET`));
  });
}

/** Without SMTP_HOST mail is written to the log instead of delivered. */
export function mailDelivery(config: ConfigReader): 'smtp' | 'log' {
  return config.get<string>('SMTP_HOST') ? 'smtp' : 'log';
}

/** Where users point `ssh`; null when the gateway is off. */
export function sshEndpoint(config: ConfigReader): { host: string; port: number } | null {
  const listen = config.get<number | string>('SSH_GATEWAY_PORT');
  if (!listen) return null;
  return {
    host: config.get<string>('SSH_PUBLIC_HOST') || new URL(publicApiUrl(config)).hostname,
    port: Number(config.get<number | string>('SSH_PUBLIC_PORT') || listen),
  };
}

/** Parent domain of exposed port URLs; null when hosted ports are off. */
export function portsDomain(config: ConfigReader): string | null {
  const domain = config.get<string>('PORTS_DOMAIN');
  const port = config.get<number | string>('PORTS_PROXY_PORT');
  return domain && port !== undefined && port !== null && port !== '' ? domain : null;
}

/** Non-secret instance facts the dashboard needs before sign-in. */
export function instanceSummary(config: ConfigReader) {
  return {
    apiUrl: publicApiUrl(config),
    appUrl: publicAppUrl(config),
    billingEnabled: false,
    authProviders: oauthProviders(config),
    mailDelivery: mailDelivery(config),
    githubAppConfigured: Boolean(config.get<string>('GITHUB_APP_ID') && config.get<string>('GITHUB_APP_PRIVATE_KEY')),
    ssh: sshEndpoint(config),
    ports: portsDomain(config) ? { domain: portsDomain(config) } : null,
    chatgptSignIn: config.get<string>('CHATGPT_SIGNIN_ENABLED') === 'true',
  };
}
