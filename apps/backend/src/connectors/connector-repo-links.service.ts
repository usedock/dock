import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { connectorRepoLinks, connectors, githubInstallations, REPO_LINK_ANY_SCOPE, type ConnectorKind, type ConnectorRepoLink } from '../database/schema';
import { ConnectorGithub, PUBLISH_PERMISSIONS, READ_PERMISSIONS } from './connector-github';
import { ConnectorsService } from './connectors.service';

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SCOPE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface RepoLinkView {
  scope: string;
  repo: string;
  createdAt: Date;
}

const view = (row: ConnectorRepoLink): RepoLinkView => ({ scope: row.scope, repo: row.repo, createdAt: row.createdAt });

/** Admin-managed mapping from a connector scope to a GitHub repository a workspace installation can reach. */
@Injectable()
export class ConnectorRepoLinksService {
  private readonly logger = new Logger(ConnectorRepoLinksService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectors: ConnectorsService,
    private readonly github: ConnectorGithub,
  ) {}

  async list(callerId: string, workspaceId: string, kind: string): Promise<{ links: RepoLinkView[] }> {
    const ws = await this.connectors.requireAdmin(callerId, workspaceId);
    const rows = await this.db
      .select()
      .from(connectorRepoLinks)
      .where(and(eq(connectorRepoLinks.workspaceId, ws.id), eq(connectorRepoLinks.kind, this.connectors.kindOf(kind))))
      .orderBy(asc(connectorRepoLinks.scope));
    return { links: rows.map(view) };
  }

  /** Creates or replaces the link for a scope after proving a workspace installation can open pull requests in the repository. */
  async put(callerId: string, workspaceId: string, kind: string, input: { scope: string; repo: string }): Promise<RepoLinkView> {
    const ws = await this.connectors.requireAdmin(callerId, workspaceId);
    const checkedKind = this.connectors.kindOf(kind);
    const scope = input.scope.trim();
    const repo = input.repo.trim();
    if (scope !== REPO_LINK_ANY_SCOPE && !SCOPE_RE.test(scope)) {
      throw new BadRequestException({ code: 'validation_error', message: 'scope must be * or an id of at most 128 letters, digits, and _ . : -' });
    }
    if (!REPO_RE.test(repo) || repo.split('/')[1].replace(/\./g, '') === '') {
      throw new BadRequestException({ code: 'validation_error', message: 'repo must be owner/name' });
    }
    const [connector] = await this.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.workspaceId, ws.id), eq(connectors.kind, checkedKind)))
      .limit(1);
    if (!connector) throw new NotFoundException({ code: 'connector_not_found', message: `${checkedKind} is not connected in this workspace` });
    const installationId = await this.findInstallation(ws.id, repo);
    const [row] = await this.db
      .insert(connectorRepoLinks)
      .values({ workspaceId: ws.id, kind: checkedKind, scope, repo, installationId, createdBy: callerId })
      .onConflictDoUpdate({
        target: [connectorRepoLinks.workspaceId, connectorRepoLinks.kind, connectorRepoLinks.scope],
        set: { repo, installationId, createdBy: callerId, updatedAt: new Date() },
      })
      .returning();
    return view(row);
  }

  async remove(callerId: string, workspaceId: string, kind: string, scope: string): Promise<{ removed: boolean }> {
    const ws = await this.connectors.requireAdmin(callerId, workspaceId);
    const rows = await this.db
      .delete(connectorRepoLinks)
      .where(and(eq(connectorRepoLinks.workspaceId, ws.id), eq(connectorRepoLinks.kind, this.connectors.kindOf(kind)), eq(connectorRepoLinks.scope, scope)))
      .returning({ id: connectorRepoLinks.id });
    if (!rows.length) throw new NotFoundException({ code: 'repo_link_not_found', message: 'No link for that scope' });
    return { removed: true };
  }

  /** The link a run's subject falls under: its own scope first, then the connector-wide `*`. */
  async resolve(workspaceId: string, kind: ConnectorKind, scope: string | undefined): Promise<ConnectorRepoLink | null> {
    const rows = await this.db
      .select()
      .from(connectorRepoLinks)
      .where(and(eq(connectorRepoLinks.workspaceId, workspaceId), eq(connectorRepoLinks.kind, kind)));
    return (scope ? rows.find((r) => r.scope === scope) : undefined) ?? rows.find((r) => r.scope === REPO_LINK_ANY_SCOPE) ?? null;
  }

  /**
   * The workspace's GitHub App installation that lists the repository and can mint a token with the publish permissions.
   * Both probe tokens are revoked at once.
   */
  private async findInstallation(workspaceId: string, repoFull: string): Promise<number> {
    if (!this.github.configured()) {
      throw new ServiceUnavailableException({ code: 'github_app_not_configured', message: 'The GitHub App is not configured on this instance' });
    }
    const installs = await this.db.select().from(githubInstallations).where(eq(githubInstallations.workspaceId, workspaceId));
    if (!installs.length) {
      throw new BadRequestException({ code: 'github_installation_missing', message: 'Install the Dock GitHub App on a repository in this workspace first' });
    }
    const name = repoFull.split('/')[1];
    let permissionsMissing = false;
    for (const install of installs) {
      let listing: string | undefined;
      let reachable = false;
      try {
        listing = await this.github.mint(install.installationId, undefined, READ_PERMISSIONS);
        const names = await this.github.api.listInstallationRepositories({ token: listing });
        reachable = names.some((n) => n.toLowerCase() === repoFull.toLowerCase());
      } catch (err) {
        this.logger.warn(`Listing repositories of installation ${install.installationId} failed: ${(err as Error).message}`);
      } finally {
        if (listing) await this.github.revoke(listing);
      }
      if (!reachable) continue;
      let probe: string | undefined;
      try {
        probe = await this.github.mint(install.installationId, name, PUBLISH_PERMISSIONS);
        return install.installationId;
      } catch {
        permissionsMissing = true;
      } finally {
        if (probe) await this.github.revoke(probe);
      }
    }
    if (permissionsMissing) {
      throw new BadRequestException({ code: 'github_permissions_missing', message: `The Dock GitHub App needs Contents and Pull requests write access on ${repoFull}` });
    }
    throw new BadRequestException({ code: 'github_repo_not_accessible', message: `No GitHub App installation of this workspace can access ${repoFull}` });
  }
}
