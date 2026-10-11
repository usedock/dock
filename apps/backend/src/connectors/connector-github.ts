import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GITHUB_API, GITHUB_API_BASE, type GithubApi } from '../github/github-api';
import { exchangeInstallationToken, mintAppJwtWithRotation, revokeInstallationToken } from '../github/github-auth';

/** Narrowest permissions per job: clone and read the base, or commit a branch and open the pull request. */
export const READ_PERMISSIONS = { contents: 'read' } as const;
export const PUBLISH_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const;

/** Mints and revokes the GitHub App installation tokens connector runs use; the App key never leaves the control plane. */
@Injectable()
export class ConnectorGithub {
  private readonly fetchFn?: typeof fetch;

  constructor(
    private readonly config: ConfigService,
    @Inject(GITHUB_API) readonly api: GithubApi,
    @Optional() options: { fetchFn?: typeof fetch } = {},
  ) {
    this.fetchFn = options?.fetchFn;
  }

  configured(): boolean {
    return !!this.config.get<string>('GITHUB_APP_ID') && !!this.config.get<string>('GITHUB_APP_PRIVATE_KEY');
  }

  /** Installation token for one repository (every repository the installation grants when `repo` is omitted), narrowed to `permissions`. */
  async mint(installationId: number, repo: string | undefined, permissions: Record<string, 'read' | 'write'>): Promise<string> {
    const jwt = mintAppJwtWithRotation(
      this.config.get<string>('GITHUB_APP_ID') ?? '',
      this.config.get<string>('GITHUB_APP_PRIVATE_KEY') ?? '',
      this.config.get<string>('GITHUB_APP_PRIVATE_KEY_PREV') ?? '',
    );
    const out = await exchangeInstallationToken({
      apiBase: GITHUB_API_BASE,
      jwt,
      installationId,
      repositories: repo ? [repo] : undefined,
      permissions,
      fetchFn: this.fetchFn,
    });
    return out.token;
  }

  /** Installation tokens live an hour and that cannot be shortened, so each one is revoked as soon as it has done its job. */
  async revoke(token: string): Promise<void> {
    await revokeInstallationToken({ apiBase: GITHUB_API_BASE, token, fetchFn: this.fetchFn });
  }
}
