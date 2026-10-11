import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { hashToken, newToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { PROVIDER_ENV_VARS, PROVIDER_NAMES, apiKeys, docks, githubInstallations, workspaces, type Dock, type EnvRepo, type ProviderName } from '../database/schema';
import { providerGatewayBundle } from '../agent-credentials/provider-gateway-dock';
import { API_KEY_PREFIX } from '../api-keys/api-keys.service';
import { CHATGPT_DOCK_AGENTS, chatgptDockBundle } from '../chatgpt/chatgpt-dock';
import { DEFAULT_DOCK_AGENTS } from '../github/run-agents';
import { MCP_CONFIG_PATH, connectorDockBundle } from '../connectors/connector-dock';
import { isConnectorKind } from '../connectors/connector-kinds';
import { ChatgptService } from '../chatgpt/chatgpt.service';
import { publicApiUrl } from '../config/instance';
import { COMPUTE_PROVIDER, type ComputeProvider } from '../docks/compute.provider';
import { exchangeInstallationToken, mintAppJwtWithRotation } from '../github/github-auth';
import type { OperationView } from '../retention/operations.service';
import { SETUP_STATUS_FILE, buildApplyScripts, cloneTokenVar, type ApplyBundle } from './env-apply-script';
import { EnvironmentNotFoundException, EnvironmentsService } from './environments.service';

const APPLY_TIMEOUT_SECONDS = 120;
const LIVE_STATES = ['ready', 'idle', 'running'] as const;
const VERSION_PIN_RE = /^v(\d+)$/;
/** Background clones and setup scripts get this long before the watcher gives up. */
const SETUP_DEADLINE_MS = 60 * 60 * 1000;
/** Rows touched this recently may still be mid-apply; the watcher leaves them alone. */
const WATCH_SETTLE_MS = 15_000;

interface PreparedBundle extends Omit<ApplyBundle, 'setupScript'> {
  /** Exec-only env: short-lived clone tokens that never reach the disk. */
  execEnv: Record<string, string>;
}

/** Copy of the vars without the named keys. */
function withoutKeys(vars: Record<string, string>, names: Set<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter(([name]) => !names.has(name)));
}

/**
 * Makes a dock's disk match its pinned environment version through the guest
 * exec agent. Outcome lands on setupStatus (running until background clones
 * and setup scripts settle); a failed apply never fails the dock itself, and
 * errors never carry secret values.
 */
@Injectable()
export class EnvironmentApplyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnvironmentApplyService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Overridable in tests; GitHub token exchange only. */
  fetchFn: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvironmentsService,
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService,
    @Optional() private readonly chatgpt?: ChatgptService,
  ) {}

  /** Applies the dock's pin; returns the dock row with its setup status. */
  async apply(dock: Dock, orgId: string, opts: { setupScript?: string } = {}): Promise<Dock> {
    await this.setStatus(dock.id, 'running', null);
    try {
      const bundle = await this.prepare(dock, orgId);
      const { scripts, background } = buildApplyScripts({ ...bundle, setupScript: opts.setupScript ?? null });
      for (const [index, script] of scripts.entries()) {
        const outcome = await this.provider().exec(dock, {
          script,
          timeoutSeconds: APPLY_TIMEOUT_SECONDS,
          env: bundle.execEnv,
          idempotencyToken: `env-apply:${dock.id}:${randomUUID()}:${index}`,
        });
        if (outcome.timedOut) throw new Error('environment apply timed out');
        if (outcome.exitCode !== 0) throw new Error(`environment apply exited ${outcome.exitCode}: ${outcome.stderr.slice(0, 300)}`);
      }
      // The fake driver runs no guest, so there is nothing to wait for.
      const settles = background && this.config.get<string>('RUNTIME_DRIVER') === 'restate';
      return (await this.setStatus(dock.id, settles ? 'running' : 'done', null)) ?? dock;
    } catch (err) {
      this.logger.warn(`Environment apply failed for dock ${dock.id}: ${(err as Error).message}`);
      return (await this.setStatus(dock.id, 'failed', (err as Error).message.slice(0, 500))) ?? dock;
    }
  }

  /** Moves pins, then applies the new version to every moved dock that is live. */
  async upgrade(callerId: string, ref: string, organizationId: string | undefined, dockIds?: string[]): Promise<{ operation: OperationView }> {
    const { operation, moved, orgId } = await this.envs.upgrade(callerId, ref, organizationId, dockIds);
    if (moved.length) {
      const live = await this.db
        .select()
        .from(docks)
        .where(and(inArray(docks.id, moved), inArray(docks.state, [...LIVE_STATES])));
      for (const dock of live) await this.apply(dock, orgId);
    }
    return { operation };
  }

  /** Settles live docks whose background setup is running from the guest's setup.status. */
  async watchOnce(now = Date.now()): Promise<{ settled: number }> {
    const rows = await this.db
      .select()
      .from(docks)
      .where(and(eq(docks.setupStatus, 'running'), inArray(docks.state, [...LIVE_STATES]), lt(docks.updatedAt, new Date(now - WATCH_SETTLE_MS))));
    let settled = 0;
    for (const dock of rows) {
      let next: { status: 'done' | 'failed'; error: string | null } | null = null;
      if (now - dock.updatedAt.getTime() > SETUP_DEADLINE_MS) {
        next = { status: 'failed', error: 'Setup did not finish within an hour; see ~/.dock/setup.log' };
      } else {
        try {
          const outcome = await this.provider().exec(dock, {
            script: `cat "$HOME/${SETUP_STATUS_FILE}" 2>/dev/null || echo running`,
            timeoutSeconds: 10,
            idempotencyToken: `env-watch:${dock.id}:${randomUUID()}`,
          });
          const line = outcome.stdout.trim().split('\n')[0] ?? '';
          if (line === 'done') next = { status: 'done', error: null };
          else if (line && line !== 'running') next = { status: 'failed', error: `Setup failed: ${line.slice(0, 300)}; see ~/.dock/setup.log` };
        } catch (err) {
          this.logger.warn(`Setup watch of ${dock.id} failed: ${(err as Error).message}`);
        }
      }
      if (!next) continue;
      // A re-apply since the read bumped updatedAt; its own outcome wins.
      const updated = await this.db
        .update(docks)
        .set({ setupStatus: next.status, setupError: next.error, updatedAt: new Date() })
        .where(and(eq(docks.id, dock.id), eq(docks.setupStatus, 'running'), eq(docks.updatedAt, dock.updatedAt)))
        .returning({ id: docks.id });
      if (updated.length) settled += 1;
    }
    return { settled };
  }

  onModuleInit(): void {
    if (this.config.get<string>('RUNTIME_DRIVER') !== 'restate') return;
    this.timer = setInterval(
      () => void this.watchOnce().catch((err) => this.logger.error(`Setup watch tick failed: ${(err as Error).message}`)),
      WATCH_SETTLE_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async prepare(dock: Dock, orgId: string): Promise<PreparedBundle> {
    const match = dock.envVersionPin ? VERSION_PIN_RE.exec(dock.envVersionPin) : null;
    const neutral = { DOCK_ID: dock.id, DOCK_API_URL: publicApiUrl(this.config) };
    let resolved: {
      vars: Record<string, string>;
      files: ApplyBundle['files'];
      repos: EnvRepo[];
      passDockCredentials: boolean;
      passAgentsCredentials: boolean;
      gatewayKeyVars: string[];
    };
    try {
      resolved = await this.envs.resolveBundle(orgId, dock.environment, {
        version: match ? Number(match[1]) : undefined,
        perDockEnv: dock.env,
        noEnv: dock.noEnv,
        agents: [...DEFAULT_DOCK_AGENTS],
      });
    } catch (err) {
      // A deleted environment withholds everything it held; per-dock env still applies.
      if (!(err instanceof EnvironmentNotFoundException)) throw err;
      resolved = { vars: { ...dock.env }, files: [], repos: [], passDockCredentials: false, passAgentsCredentials: false, gatewayKeyVars: [] };
    }
    const credential = await this.rotateCredential(dock, resolved.passDockCredentials);
    // Gateway mode: real provider keys never leave the control plane; the dock gets the token as the key instead.
    const gatewayVars = new Set(resolved.gatewayKeyVars);
    const gatewayProviders = PROVIDER_NAMES.filter((p) => PROVIDER_ENV_VARS[p].some((n) => gatewayVars.has(n)));
    const chatgpt = await this.rotateLlmToken(dock, resolved.passAgentsCredentials, gatewayProviders);
    const connectors = await this.rotateConnectorToken(dock);
    return {
      // Environment and per-dock vars win over the ChatGPT and connector wiring, as they do over platform keys.
      vars: { ...connectors.vars, ...chatgpt.vars, ...withoutKeys(resolved.vars, gatewayVars), ...neutral, ...(credential ? { DOCK_API_KEY: credential } : {}) },
      files: [...resolved.files, ...chatgpt.files, ...connectors.files],
      repos: resolved.repos,
      removeFiles: connectors.files.length ? [] : [MCP_CONFIG_PATH],
      execEnv: await this.cloneTokens(orgId, resolved.repos),
    };
  }

  /** One live key per dock acting as its creator; every apply replaces it, withholding deletes it. */
  private async rotateCredential(dock: Dock, allowed: boolean): Promise<string | null> {
    await this.db.delete(apiKeys).where(eq(apiKeys.dockId, dock.id));
    if (!allowed || !dock.createdBy) return null;
    const raw = `${API_KEY_PREFIX}${newToken()}`;
    await this.db.insert(apiKeys).values({
      userId: dock.createdBy,
      dockId: dock.id,
      name: `dock ${dock.name}`,
      keyHash: hashToken(raw),
      keyPrefix: raw.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8),
    });
    return raw;
  }

  /**
   * One dock-scoped gateway token covers the creator's ChatGPT sign-in (codex,
   * opencode) and the org provider keys (placeholder plus base URLs). Every
   * apply replaces it; losing both uses, or the credential posture, clears it.
   */
  private async rotateLlmToken(dock: Dock, allowed: boolean, providers: ProviderName[]): Promise<{ vars: Record<string, string>; files: { path: string; contents: string }[] }> {
    const agents = DEFAULT_DOCK_AGENTS.filter((a) => (CHATGPT_DOCK_AGENTS as readonly string[]).includes(a));
    const chatgptUsable = allowed && agents.length > 0 && !!dock.createdBy && !!(await this.chatgpt?.usable(dock.createdBy));
    const gateway = allowed ? providers : [];
    const raw = chatgptUsable || gateway.length ? newToken() : null;
    if (raw || dock.llmTokenHash) {
      await this.db.update(docks).set({ llmTokenHash: raw ? hashToken(raw) : null }).where(eq(docks.id, dock.id));
    }
    if (!raw) return { vars: {}, files: [] };
    const base = `${publicApiUrl(this.config)}/v1/llm`;
    const chatgpt = chatgptUsable ? chatgptDockBundle(raw, `${base}/chatgpt`, agents) : { vars: {}, files: [] };
    const keys = providerGatewayBundle(raw, base, gateway, chatgpt.vars.OPENCODE_CONFIG_CONTENT);
    return { vars: { ...chatgpt.vars, ...keys.vars }, files: chatgpt.files };
  }

  /** Docks created with connectors get a fresh gateway token on every apply; the old one stops working. */
  private async rotateConnectorToken(dock: Dock): Promise<ReturnType<typeof connectorDockBundle>> {
    const kinds = (dock.connectors ?? []).filter(isConnectorKind);
    if (!kinds.length) return { vars: {}, files: [] };
    const raw = newToken();
    await this.db.update(docks).set({ connectorTokenHash: hashToken(raw) }).where(eq(docks.id, dock.id));
    return connectorDockBundle(raw, `${publicApiUrl(this.config)}/v1/connectors/gateway`, kinds);
  }

  /** Read-only installation tokens for GitHub repos an org installation can reach; misses fall back to env tokens. */
  private async cloneTokens(orgId: string, repos: EnvRepo[]): Promise<Record<string, string>> {
    const github = repos.filter((r) => r.provider === 'github');
    const appId = this.config.get<string>('GITHUB_APP_ID') ?? '';
    const key = this.config.get<string>('GITHUB_APP_PRIVATE_KEY') ?? '';
    if (!github.length || !appId || !key) return {};
    const installations = await this.db
      .select({ installationId: githubInstallations.installationId, repos: githubInstallations.repos })
      .from(githubInstallations)
      .innerJoin(workspaces, eq(workspaces.id, githubInstallations.workspaceId))
      .where(eq(workspaces.organizationId, orgId));
    if (!installations.length) return {};
    const env: Record<string, string> = {};
    for (const repo of github) {
      for (const installation of installations.filter((i) => i.repos.some((r) => r.toLowerCase() === repo.fullName.toLowerCase()))) {
        try {
          const jwt = mintAppJwtWithRotation(appId, key, this.config.get<string>('GITHUB_APP_PRIVATE_KEY_PREV') ?? '');
          const out = await exchangeInstallationToken({
            apiBase: 'https://api.github.com',
            jwt,
            installationId: installation.installationId,
            repositories: [repo.fullName.split('/')[1]],
            permissions: { contents: 'read' },
            fetchFn: this.fetchFn,
          });
          env[cloneTokenVar(repo)] = out.token;
          break;
        } catch {
          // Token mint failed for this installation; try the next one.
        }
      }
    }
    return env;
  }

  private async setStatus(id: string, setupStatus: Dock['setupStatus'], setupError: string | null): Promise<Dock | undefined> {
    const [row] = await this.db
      .update(docks)
      .set({ setupStatus, setupError, updatedAt: new Date() })
      .where(eq(docks.id, id))
      .returning();
    return row;
  }

  // Resolved lazily: the provider lives in DocksModule, which imports this module.
  private provider(): ComputeProvider {
    return this.moduleRef.get<ComputeProvider>(COMPUTE_PROVIDER, { strict: false });
  }
}
