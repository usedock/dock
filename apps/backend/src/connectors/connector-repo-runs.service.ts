import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { connectorRunRepos, githubInstallations, type ConnectorKind, type ConnectorRepoLink, type ConnectorRun, type ConnectorRunRepo } from '../database/schema';
import { sanitizeIssueText } from '../github/agent-prompt';
import type { GitTreeEntry } from '../github/github-api';
import { safeRepoPath } from '../github/github.service';
import { ConnectorGithub, PUBLISH_PERMISSIONS, READ_PERMISSIONS } from './connector-github';
import { redactSecrets } from './connector-redact';
import type { ConnectorTrigger } from './connector-triggers';

export interface RunChange {
  path: string;
  mode?: '100644' | '100755' | '120000';
  content?: string;
  deleted?: boolean;
}

export interface PreparedRepo {
  /** Read-only clone token for the one exec that clones; revoke it right after. */
  readToken: string;
  repo: ConnectorRunRepo;
}

/** A failure with a short code safe to show the requester. */
export class RepoPublishError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const KIND_LABEL: Record<ConnectorKind, string> = {
  linear: 'Linear issue',
  slack: 'Slack thread',
  sentry: 'Sentry issue',
  figma: 'Figma file',
};

/** Keeps text on one line and stops `@name` from pinging GitHub users from a subject or summary. */
const plain = (text: string, max: number): string => sanitizeIssueText(text).replace(/\s+/g, ' ').trim().slice(0, max);
const noMentions = (text: string): string => text.replace(/@(?=[A-Za-z0-9])/g, '@​');
const httpsUrl = (url: string | null): string | null => (url && /^https:\/\/[^\s]{1,500}$/.test(url) ? url : null);

/** Gives a linked run its repository and, when the agent changed files, commits them and opens the pull request from the control plane. */
@Injectable()
export class ConnectorRepoRunsService {
  private readonly logger = new Logger(ConnectorRepoRunsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly github: ConnectorGithub,
  ) {}

  /** Pins the base commit and mints the read-only clone token for one repository; the dock never holds a write credential. */
  async prepare(run: ConnectorRun, link: ConnectorRepoLink, trigger: ConnectorTrigger): Promise<PreparedRepo> {
    const [owner, name] = link.repo.split('/');
    const readToken = await this.github.mint(link.installationId, name, READ_PERMISSIONS);
    try {
      const baseBranch = await this.github.api.getDefaultBranch({ token: readToken, owner, repo: name });
      const { sha } = await this.github.api.getBranchHead({ token: readToken, owner, repo: name, branch: baseBranch });
      const [row] = await this.db
        .insert(connectorRunRepos)
        .values({
          runId: run.id,
          workspaceId: run.workspaceId,
          repo: link.repo,
          installationId: link.installationId,
          baseBranch,
          baseSha: sha,
          branch: `dock/${run.kind}-${run.id.slice(0, 8)}`,
          title: plain(trigger.title, 200) || KIND_LABEL[run.kind],
          subjectUrl: httpsUrl(trigger.url),
        })
        .returning();
      return { readToken, repo: row };
    } catch (err) {
      await this.github.revoke(readToken);
      throw err;
    }
  }

  async forRun(runId: string): Promise<ConnectorRunRepo | null> {
    const [row] = await this.db.select().from(connectorRunRepos).where(eq(connectorRunRepos.runId, runId)).limit(1);
    return row ?? null;
  }

  revoke(token: string): Promise<void> {
    return this.github.revoke(token);
  }

  /** Commits the change set on `dock/<kind>-<id>` through the Git Data API and opens a draft pull request; returns its URL. */
  async publish(run: ConnectorRun, repo: ConnectorRunRepo, input: { parentSha?: string; changes: RunChange[]; summary: string }): Promise<string> {
    if (!input.changes.length) throw new RepoPublishError('empty_fix');
    if (input.parentSha !== repo.baseSha) throw new RepoPublishError('push_failed');
    if (input.changes.some((c) => !safeRepoPath(c.path))) throw new RepoPublishError('unsupported_change');
    // The publish token has no `workflows` permission, so GitHub would refuse these anyway; say why.
    if (input.changes.some((c) => /^\.github\/workflows\//i.test(c.path))) throw new RepoPublishError('workflow_change_refused');
    const [installed] = await this.db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.workspaceId, run.workspaceId), eq(githubInstallations.installationId, repo.installationId)))
      .limit(1);
    if (!installed) throw new RepoPublishError('repo_unavailable');
    const [owner, name] = repo.repo.split('/');
    let token: string;
    try {
      token = await this.github.mint(repo.installationId, name, PUBLISH_PERMISSIONS);
    } catch {
      throw new RepoPublishError('token_mint_failed');
    }
    try {
      const api = this.github.api;
      const base = { token, owner, repo: name };
      const { treeSha } = await api.getCommitTree({ ...base, sha: repo.baseSha });
      const entries: GitTreeEntry[] = [];
      for (const change of input.changes) {
        if (change.deleted) {
          entries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const blob = await api.createBlob({ ...base, contentBase64: change.content ?? '' });
        entries.push({ path: change.path, mode: change.mode ?? '100644', type: 'blob', sha: blob.sha });
      }
      const tree = await api.createTree({ ...base, baseTree: treeSha, entries });
      const commit = await api.createCommit({ ...base, message: `[dock] ${repo.title}\n\nDock run ${run.id}`, tree: tree.sha, parents: [repo.baseSha] });
      try {
        await api.setBranch({ ...base, branch: repo.branch, sha: commit.sha, create: true });
      } catch {
        throw new RepoPublishError('push_failed');
      }
      try {
        const pr = await api.createPullRequest({
          ...base,
          head: repo.branch,
          base: repo.baseBranch,
          title: `[dock] ${repo.title}`.slice(0, 250),
          body: this.prBody(run, repo, input.summary),
          draft: true,
        });
        if (!pr.url) throw new Error('no url');
        await this.db.update(connectorRunRepos).set({ prUrl: pr.url }).where(eq(connectorRunRepos.runId, run.id));
        return pr.url;
      } catch {
        throw new RepoPublishError('pr_create_failed');
      }
    } catch (err) {
      if (err instanceof RepoPublishError) throw err;
      this.logger.warn(`Commit for connector run ${run.id} failed: ${(err as Error).message}`);
      throw new RepoPublishError('push_failed');
    } finally {
      await this.github.revoke(token);
    }
  }

  private prBody(run: ConnectorRun, repo: ConnectorRunRepo, summary: string): string {
    const origin = repo.subjectUrl ?? (run.kind === 'slack' && run.reply.channel ? `channel ${run.reply.channel}` : repo.title);
    return noMentions(
      [
        `Opened by Dock from a ${KIND_LABEL[run.kind]}: ${origin}`,
        '',
        redactSecrets(summary, [], 1500) || 'Automated change.',
        '',
        `Dock run ${run.id}. Opened as a draft: review the change before merging.`,
      ].join('\n'),
    );
  }
}
