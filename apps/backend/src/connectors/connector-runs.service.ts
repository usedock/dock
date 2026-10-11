import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'crypto';
import { isUniqueViolation } from '../organizations/organizations.service';
import { publicApiUrl } from '../config/instance';
import { hashToken, newToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { connectorRuns, connectors, workspaces, type Connector, type ConnectorRepoLink, type ConnectorKind, type ConnectorReplyTarget, type ConnectorRun } from '../database/schema';
import { COMPUTE_PROVIDER, type ComputeProvider } from '../docks/compute.provider';
import { DocksService } from '../docks/docks.service';
import { EnvironmentsService } from '../environments/environments.service';
import { providerOf, selectRunModel } from '../github/runner';
import { createConnectorFetch } from './connector-fetch';
import { redactSecrets } from './connector-redact';
import { linearSetState, postReply } from './connector-replies';
import { buildConnectorRunScript, buildRepoCloneScript, CONNECTOR_RUN_AGENTS, renderConnectorRequest, renderConnectorSystem } from './connector-run-script';
import { ConnectorRepoLinksService } from './connector-repo-links.service';
import { ConnectorRepoRunsService, RepoPublishError, type RunChange } from './connector-repo-runs.service';
import type { ConnectorTrigger } from './connector-triggers';
import { ConnectorsService } from './connectors.service';

const SWEEP_INTERVAL_MS = 60_000;
const LAUNCH_TIMEOUT_SECONDS = 120;
const DEFAULT_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_CONCURRENT = 5;
/** Dock lifetime beyond the agent budget, so setup and shutdown fit. */
const DOCK_SLACK_MINUTES = 15;
const TERMINAL_STATUS = new Set(['done', 'no_change', 'failed']);
const ACTIVE = ['pending', 'working'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StartOutcome = { status: 'started'; id: string } | { status: 'duplicate' } | { status: 'busy' };

export interface CompleteConnectorRunInput {
  status: string;
  summary?: string;
  reason?: string;
  /** Only read for runs linked to a repository. */
  parentSha?: string;
  changes?: RunChange[];
}

function tokensEqual(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(provided), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Runs agents for connector events: a dock with the tool attached and no environment secrets,
 * model access only through the LLM gateway with a run-scoped token, the result scrubbed and posted back.
 */
@Injectable()
export class ConnectorRunsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorRunsService.name);
  private readonly inflight = new Set<Promise<unknown>>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly fetchFn: typeof fetch;
  private readonly tokenFn: () => string;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
    private readonly connectors: ConnectorsService,
    private readonly envs: EnvironmentsService,
    private readonly config: ConfigService,
    private readonly repoLinks: ConnectorRepoLinksService,
    private readonly repoRuns: ConnectorRepoRunsService,
    @Optional() options: { fetchFn?: typeof fetch; tokenFn?: () => string } = {},
  ) {
    this.fetchFn = options?.fetchFn ?? createConnectorFetch();
    this.tokenFn = options?.tokenFn ?? newToken;
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      this.sweepTimeouts().catch((err) => this.logger.warn(`Connector run sweep failed: ${(err as Error).message}`));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.settled();
  }

  private timeoutMinutes(): number {
    const raw = Number(this.config.get<string>('CONNECTOR_RUN_TIMEOUT_MINUTES'));
    return Number.isInteger(raw) && raw >= 5 ? raw : DEFAULT_TIMEOUT_MINUTES;
  }

  private maxConcurrent(): number {
    const raw = Number(this.config.get<string>('CONNECTOR_RUN_MAX_CONCURRENT'));
    return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_CONCURRENT;
  }

  private agent(): string {
    return this.config.get<string>('CONNECTOR_RUN_AGENT') || 'opencode';
  }

  /** Admits a run unless the subject already has one in flight or the workspace is at its cap; checks and insert are atomic per workspace. */
  async start(connector: Connector, trigger: ConnectorTrigger): Promise<StartOutcome> {
    const [ws] = await this.db.select({ organizationId: workspaces.organizationId }).from(workspaces).where(eq(workspaces.id, connector.workspaceId)).limit(1);
    const completion = this.tokenFn();
    const gateway = this.tokenFn();
    let outcome: { run: ConnectorRun } | { status: 'duplicate' | 'busy' };
    try {
      outcome = await this.db.transaction(async (tx) => {
        // Concurrent webhooks for one workspace queue here, so the cap and the dedupe read what the last insert wrote.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('connector_runs'), hashtext(${connector.workspaceId}))`);
        const active = await tx
          .select({ kind: connectorRuns.kind, triggerKey: connectorRuns.triggerKey })
          .from(connectorRuns)
          .where(and(eq(connectorRuns.workspaceId, connector.workspaceId), inArray(connectorRuns.state, [...ACTIVE])));
        if (active.some((r) => r.kind === trigger.kind && r.triggerKey === trigger.key)) return { status: 'duplicate' as const };
        if (active.length >= this.maxConcurrent()) return { status: 'busy' as const };
        const [row] = await tx
          .insert(connectorRuns)
          .values({
            workspaceId: connector.workspaceId,
            organizationId: ws?.organizationId ?? null,
            kind: trigger.kind,
            triggerKey: trigger.key,
            agent: this.agent(),
            reply: trigger.reply,
            completionTokenHash: hashToken(completion),
            gatewayTokenHash: hashToken(gateway),
          })
          .returning();
        return { run: row };
      });
    } catch (err) {
      // Backstop: the unique open-run index refuses a second run for one subject.
      if (isUniqueViolation(err)) return { status: 'duplicate' };
      throw err;
    }
    if (!('run' in outcome)) return outcome;
    this.background(this.execute(outcome.run, connector, trigger, completion, gateway));
    return { status: 'started', id: outcome.run.id };
  }

  /** Posts a short notice (refusal, busy) in the background; replies are scrubbed like any other. */
  notify(workspaceId: string, kind: ConnectorKind, target: ConnectorReplyTarget, text: string): void {
    this.background(
      this.connectors
        .accessFor(workspaceId, kind)
        .then((access) => postReply(this.fetchFn, kind, access, target, text))
        .catch((err) => this.logger.warn(`Notice to ${kind} failed: ${(err as Error).message}`)),
    );
  }

  private background(work: Promise<unknown>): void {
    const tracked = work
      .catch((err) => this.logger.warn(`Connector run step failed: ${(err as Error).message}`))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Resolves when background work settles. Tests and shutdown only. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Model the org's provider keys can serve through the gateway; the keys themselves never leave the control plane. */
  private async pickModel(orgId: string | null, agent: string): Promise<string | null> {
    if (!orgId) return null;
    try {
      const bundle = await this.envs.resolveBundle(orgId, undefined, { agents: [agent] });
      return selectRunModel(bundle.vars, this.config.get<string>('CONNECTOR_RUN_MODEL') || undefined, agent);
    } catch {
      return null;
    }
  }

  private async execute(run: ConnectorRun, connector: Connector, trigger: ConnectorTrigger, completion: string, gateway: string): Promise<void> {
    await this.notifyStart(run);
    // Docks with connectors are admin-only (#66), so the run acts for the admin who connected the tool.
    if (!connector.createdBy) return this.fail(run, 'no_owner');
    const agent = run.agent;
    if (!(CONNECTOR_RUN_AGENTS as readonly string[]).includes(agent)) return this.fail(run, 'agent_unsupported');
    const model = await this.pickModel(run.organizationId, agent);
    if (!model) return this.fail(run, 'provider_not_configured');
    run = (await this.update(run, { model })) ?? run;
    let link;
    try {
      link = await this.repoLinks.resolve(run.workspaceId, run.kind, trigger.scope);
    } catch {
      return this.fail(run, 'repo_unavailable');
    }
    const minutes = this.timeoutMinutes();
    let dock;
    try {
      // noEnv: none of the workspace environment's variables, files or provider keys enter the dock.
      dock = await this.docks.create(
        connector.createdBy,
        {
          workspaceId: run.workspaceId,
          connectors: [run.kind],
          noEnv: true,
          ttlSeconds: (minutes + DOCK_SLACK_MINUTES) * 60,
          ...(this.config.get<string>('CONNECTOR_RUN_SETUP_SCRIPT') ? { setupScript: this.config.get<string>('CONNECTOR_RUN_SETUP_SCRIPT') } : {}),
        },
        `connector-run:${run.id}`,
      );
    } catch (err) {
      this.logger.warn(`Dock for connector run ${run.id} failed: ${(err as Error).message}`);
      return this.fail(run, 'dock_provision_failed');
    }
    run = (await this.update(run, { dockId: dock.id, state: 'working' })) ?? run;
    let repoName: { name: string; baseBranch: string } | undefined;
    if (link) {
      try {
        repoName = await this.cloneRepo(run, link, trigger, dock);
      } catch (err) {
        this.logger.warn(`Repository for connector run ${run.id} failed: ${(err as Error).message}`);
        return this.fail(run, 'repo_unavailable');
      }
    }
    const script = buildConnectorRunScript({
      repoLinked: !!repoName,
      system: renderConnectorSystem({ kind: trigger.kind, timeoutMinutes: minutes, repo: repoName }),
      request: renderConnectorRequest(trigger),
      callbackUrl: `${this.callbackBase()}/v1/connectors/runs/${run.id}/complete`,
      agent,
      model,
      gatewayUrl: `${this.callbackBase()}/v1/llm/${providerOf(model)}`,
      timeoutMinutes: minutes,
    });
    try {
      const out = await this.provider.exec(dock, {
        script,
        timeoutSeconds: LAUNCH_TIMEOUT_SECONDS,
        env: { CONNECTOR_RUN_TOKEN: completion, DOCK_LLM_TOKEN: gateway },
        idempotencyToken: `connector-run:${run.id}:launch`,
      });
      if (out.exitCode !== 0) throw new Error(`launch exited ${out.exitCode}`);
    } catch (err) {
      this.logger.warn(`Launch of connector run ${run.id} failed: ${(err as Error).message}`);
      await this.fail(run, 'launch_failed');
    }
  }

  /** Clones the linked repository with a read-only, single-repository token that exists only for this exec and is revoked right after. */
  private async cloneRepo(run: ConnectorRun, link: ConnectorRepoLink, trigger: ConnectorTrigger, dock: Parameters<ComputeProvider['exec']>[0]): Promise<{ name: string; baseBranch: string }> {
    const prepared = await this.repoRuns.prepare(run, link, trigger);
    try {
      const out = await this.provider.exec(dock, {
        script: buildRepoCloneScript({ repoFull: prepared.repo.repo, baseBranch: prepared.repo.baseBranch, baseSha: prepared.repo.baseSha, branch: prepared.repo.branch }),
        timeoutSeconds: LAUNCH_TIMEOUT_SECONDS,
        env: { GITHUB_CLONE_TOKEN: prepared.readToken },
        idempotencyToken: `connector-run:${run.id}:clone`,
      });
      if (out.exitCode !== 0) throw new Error(`clone exited ${out.exitCode}`);
    } finally {
      await this.repoRuns.revoke(prepared.readToken);
    }
    return { name: prepared.repo.repo, baseBranch: prepared.repo.baseBranch };
  }

  private callbackBase(): string {
    return (this.config.get<string>('GITHUB_CALLBACK_BASE_URL') || publicApiUrl(this.config)).replace(/\/+$/, '');
  }

  /** Callback from the run's dock, authorized by the run's own token; the first result wins. */
  async complete(runId: string, auth: string | string[] | undefined, input: CompleteConnectorRunInput): Promise<{ runId: string; state: string }> {
    const [run] = UUID_RE.test(runId) ? await this.db.select().from(connectorRuns).where(eq(connectorRuns.id, runId)).limit(1) : [];
    if (!run) throw new NotFoundException({ code: 'connector_run_not_found', message: 'Run not found' });
    const header = Array.isArray(auth) ? auth[0] : auth;
    const provided = /^Bearer (.+)$/.exec(header?.trim() ?? '')?.[1];
    if (!provided || !tokensEqual(provided, run.completionTokenHash)) {
      throw new UnauthorizedException({ code: 'invalid_completion_token', message: 'Invalid completion token' });
    }
    if (!TERMINAL_STATUS.has(input.status)) throw new BadRequestException({ code: 'validation_error', message: 'status must be done, no_change or failed' });
    // The dock is not trusted to scrub its own output; the run's tokens are 256-bit hex and match the patterns.
    const [claimed] = await this.db
      .update(connectorRuns)
      .set({
        state: input.status === 'failed' ? 'failed' : 'succeeded',
        summary: input.summary === undefined ? null : redactSecrets(input.summary),
        reason: input.reason === undefined ? null : redactSecrets(input.reason, [], 200),
        updatedAt: new Date(),
      })
      .where(and(eq(connectorRuns.id, run.id), inArray(connectorRuns.state, [...ACTIVE])))
      .returning();
    if (!claimed) return { runId: run.id, state: run.state };
    this.background(this.finish(claimed, input.status, input));
    return { runId: run.id, state: claimed.state };
  }

  private async finish(run: ConnectorRun, status: string, input: CompleteConnectorRunInput): Promise<void> {
    let text =
      status === 'failed'
        ? `Dock could not finish this${run.reason ? ` (${run.reason})` : ''}.${run.summary ? `\n\n${run.summary}` : ''}`
        : run.summary || (status === 'no_change' ? 'Nothing needed to change.' : 'Done.');
    let opened = false;
    if (status === 'done' && input.changes?.length) {
      const note = await this.openPullRequest(run, input);
      if (note) {
        text = `${text}\n\n${note.text}`;
        opened = note.opened;
      }
    }
    await this.reply(run, text, status === 'done' && !opened);
    await this.stopDock(run);
  }

  /** Pull request for a linked run's changes; null when the run has no repository, so the reply stays as it was. */
  private async openPullRequest(run: ConnectorRun, input: CompleteConnectorRunInput): Promise<{ text: string; opened: boolean } | null> {
    try {
      const repo = await this.repoRuns.forRun(run.id);
      if (!repo) return null;
      const url = await this.repoRuns.publish(run, repo, { parentSha: input.parentSha, changes: input.changes ?? [], summary: run.summary ?? '' });
      return { text: `Pull request: ${url}`, opened: true };
    } catch (err) {
      const code = err instanceof RepoPublishError ? err.code : 'push_failed';
      if (!(err instanceof RepoPublishError)) this.logger.warn(`Pull request for connector run ${run.id} failed: ${(err as Error).message}`);
      return { text: `Dock changed files but could not open a pull request (${code}).`, opened: false };
    }
  }

  /** Marks an unfinished run failed and says so; a run another path already settled is left alone, with no second reply. */
  private async fail(run: ConnectorRun, reason: string, state: 'failed' | 'timed_out' = 'failed'): Promise<void> {
    const failed = await this.update(run, { state, reason }, true);
    if (!failed) return;
    await this.reply(failed, `Dock could not finish this (${reason}).`, false);
    await this.stopDock(failed);
  }

  private async update(
    run: ConnectorRun,
    patch: Partial<Pick<ConnectorRun, 'state' | 'dockId' | 'reason' | 'model'>>,
    unfinishedOnly = false,
  ): Promise<ConnectorRun | undefined> {
    const where = unfinishedOnly ? and(eq(connectorRuns.id, run.id), inArray(connectorRuns.state, [...ACTIVE])) : eq(connectorRuns.id, run.id);
    const [row] = await this.db.update(connectorRuns).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    return row;
  }

  /** Linear moves to started; Slack and Figma get a short acknowledgement. */
  private async notifyStart(run: ConnectorRun): Promise<void> {
    try {
      const access = await this.connectors.accessFor(run.workspaceId, run.kind);
      if (run.kind === 'linear' && run.reply.issueId) await linearSetState(this.fetchFn, access, run.reply.issueId, 'started');
      else if (run.kind === 'slack' || run.kind === 'figma') await postReply(this.fetchFn, run.kind, access, run.reply, 'On it.');
    } catch (err) {
      this.logger.warn(`Start notice for connector run ${run.id} failed: ${(err as Error).message}`);
    }
  }

  private async reply(run: ConnectorRun, text: string, completed: boolean): Promise<void> {
    try {
      const access = await this.connectors.accessFor(run.workspaceId, run.kind);
      await postReply(this.fetchFn, run.kind, access, run.reply, text);
      if (run.kind === 'linear' && completed && run.reply.issueId) await linearSetState(this.fetchFn, access, run.reply.issueId, 'completed');
    } catch (err) {
      this.logger.warn(`Reply for connector run ${run.id} failed: ${(err as Error).message}`);
    }
  }

  /** Stopping the dock revokes its connector token (gateway tokens work only on live docks); the run's LLM token dies with the run state. */
  private async stopDock(run: ConnectorRun): Promise<void> {
    if (!run.dockId) return;
    try {
      const [owner] = await this.db
        .select({ createdBy: connectors.createdBy })
        .from(connectors)
        .where(and(eq(connectors.workspaceId, run.workspaceId), eq(connectors.kind, run.kind)))
        .limit(1);
      if (owner?.createdBy) await this.docks.stop(owner.createdBy, run.dockId, {});
    } catch (err) {
      this.logger.warn(`Stopping dock of connector run ${run.id} failed: ${(err as Error).message}`);
    }
  }

  /** Runs whose dock never reported fail with a reply, and old dedupe rows are dropped. */
  async sweepTimeouts(): Promise<{ swept: number }> {
    const cutoff = new Date(Date.now() - (this.timeoutMinutes() + DOCK_SLACK_MINUTES) * 60_000);
    const stale = await this.db
      .select()
      .from(connectorRuns)
      .where(and(inArray(connectorRuns.state, [...ACTIVE]), lt(connectorRuns.createdAt, cutoff)));
    for (const run of stale) await this.fail(run, 'timed_out', 'timed_out');
    await this.connectors.pruneDeliveries();
    return { swept: stale.length };
  }
}
