import { BadGatewayException, BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { isInstanceAdmin, isUnverifiedInstanceAdmin, publicApiUrl, publicAppUrl } from '../config/instance';
import { REDIS } from '../redis/redis.module';

/** GitHub caps the whole manifest round trip at one hour. */
const STATE_TTL_SECONDS = 3600;
const GITHUB_WEB = 'https://github.com';
const GITHUB_API = 'https://api.github.com';
/** GitHub App names are capped at 34 characters. */
const MAX_APP_NAME = 34;

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  request_oauth_on_install: boolean;
  public: boolean;
  default_permissions: Record<string, 'read' | 'write'>;
  default_events: string[];
}

interface Conversion {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  owner?: { login?: string };
  webhook_secret: string;
  client_id: string;
  client_secret: string;
  pem: string;
}

function forbidden(message: string): ForbiddenException {
  return new ForbiddenException({ code: 'instance_admin_required', message });
}

/** Env lines in dotenv / compose env_file form; the PEM stays on one line with `\n` escapes. */
export function envBlock(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value.replace(/\r?\n/g, '\\n').replace(/"/g, '\\"')}"`)
    .join('\n');
}

/**
 * One-click GitHub App registration through GitHub's App Manifest flow. The
 * credentials are shown once to an instance admin to paste into the env;
 * nothing is persisted here.
 */
@Injectable()
export class GithubAppSetupService {
  /** Overridable in tests. */
  fetchFn: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  manifest(): AppManifest {
    const app = publicAppUrl(this.config);
    const api = publicApiUrl(this.config);
    return {
      name: `Dock ${new URL(app).hostname}`.slice(0, MAX_APP_NAME),
      url: app,
      hook_attributes: { url: `${api}/v1/github/webhooks`, active: true },
      redirect_url: `${app}/developers/github/setup`,
      // With request_oauth_on_install GitHub sends the user to the first callback URL, not the Setup URL.
      callback_urls: [`${app}/developers/github/installed`, app],
      request_oauth_on_install: true,
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', members: 'read' },
      // `installation` is delivered to every App and cannot be subscribed to explicitly.
      default_events: ['issue_comment'],
    };
  }

  /** Issues a single-use state bound to the caller plus the GitHub form target. */
  async start(caller: RequestUser, organization?: string) {
    this.requireAdmin(caller);
    const state = randomBytes(16).toString('hex');
    await this.redis.set(`gh:manifest:${state}`, caller.id, 'EX', STATE_TTL_SECONDS);
    const owner = organization ? `/organizations/${encodeURIComponent(organization)}` : '';
    return {
      postUrl: `${GITHUB_WEB}${owner}/settings/apps/new?state=${state}`,
      manifest: JSON.stringify(this.manifest()),
      state,
    };
  }

  /** Exchanges the redirect code for the new App's credentials, once. */
  async convert(caller: RequestUser, code: string, state: string) {
    this.requireAdmin(caller);
    const owner = await this.redis.getdel(`gh:manifest:${state}`);
    if (owner !== caller.id) {
      throw new BadRequestException({ code: 'invalid_state', message: 'Manifest state is unknown, expired, or not yours' });
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
    } catch (err) {
      throw new BadGatewayException({ code: 'github_unavailable', message: `GitHub unreachable: ${(err as Error).message}` });
    }
    if (res.status === 404 || res.status === 422) {
      throw new BadRequestException({ code: 'invalid_code', message: 'GitHub rejected the code; it is single-use and expires after one hour' });
    }
    if (!res.ok) {
      throw new BadGatewayException({ code: 'github_unavailable', message: `GitHub answered ${res.status}` });
    }
    const app = (await res.json()) as Conversion;
    const env = {
      GITHUB_APP_ID: String(app.id),
      GITHUB_APP_SLUG: app.slug,
      GITHUB_APP_PRIVATE_KEY: app.pem,
      GITHUB_APP_WEBHOOK_SECRET: app.webhook_secret,
      GITHUB_APP_CLIENT_ID: app.client_id,
      GITHUB_APP_CLIENT_SECRET: app.client_secret,
    };
    return {
      appId: app.id,
      slug: app.slug,
      name: app.name,
      owner: app.owner?.login ?? null,
      htmlUrl: app.html_url,
      installUrl: `${app.html_url}/installations/new`,
      env,
      envFile: envBlock(env),
    };
  }

  /** Interactive sessions whose verified email is listed in INSTANCE_ADMIN_EMAILS. */
  private requireAdmin(caller: RequestUser): void {
    if (caller.isInteractive !== true) throw forbidden('GitHub App setup needs an interactive browser session');
    if (!this.config.get<string>('INSTANCE_ADMIN_EMAILS')?.trim()) throw forbidden('Set INSTANCE_ADMIN_EMAILS on the backend to enable GitHub App setup');
    if (isUnverifiedInstanceAdmin(this.config, caller)) throw forbidden('Verify your email to use instance admin features');
    if (!isInstanceAdmin(this.config, caller)) throw forbidden('Only instance admins can register the GitHub App');
  }
}
