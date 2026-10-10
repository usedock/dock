import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type Redis from 'ioredis';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { REDIS } from '../redis/redis.module';
import { DocksService } from '../docks/docks.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { MeteringService } from '../metering/metering.service';
import { SpendGate } from '../metering/spend-gate';
import { FAST_RUN_PROVIDER, type FastRunProvider, type RuntimeRef } from '../runtime/fast-run.provider';
import { HostsService } from '../hosts/hosts.service';
import { RunArtifactsService } from './run-artifacts.service';
import { runView, type RunView } from './run-view';
import { OrganizationsService, isUniqueViolation } from '../organizations/organizations.service';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { DB, Db } from '../database/database.module';
import {
  account,
  DEFAULT_CPUS,
  DEFAULT_DISK_GIB,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY_MIB,
  GITHUB_EXECUTION_TARGETS,
  GITHUB_RUN_STATES,
  githubInstallations,
  githubRuns,
  githubWebhookDeliveries,
  workspaces,
  type GithubExecutionTarget,
  type GithubRun,
  type GithubRunState,
} from '../database/schema';
import { hashToken, newToken } from '../crypto/tokens';
import { EnvironmentsService } from '../environments/environments.service';
import { ChatgptService } from '../chatgpt/chatgpt.service';
import { requiredKeysFor, runAgentNames } from './run-agents';
import { exchangeInstallationToken, mintAppJwtWithRotation, verifyGithubSignature } from './github-auth';
import { GITHUB_API, type GithubApi, type GitTreeEntry } from './github-api';
import { hasDockMention, isAppSender, isIssueTarget, parseBaseBranch, parseExecutionTarget, parseRunCapabilities } from './mention';
import {
  PROMPT_VERSION,
  REPO_INSTRUCTION_FILES,
  envelopeHash,
  renderConstraintsMd,
  renderIssueMd,
  renderSystemPrompt,
} from './agent-prompt';
import {
  CHATGPT_SESSION,
  RUN_ARTIFACT_DIR,
  RUN_ARTIFACT_FILES,
  assertRunnerFits,
  assertSupportedAgent,
  autoDetectTestCommand,
  buildLaunchScript,
  buildPrepareScript,
  providerOf,
  selectRunModel,
  validateMappingAgent,
  validateTestCommand,
} from './runner';
import { FAST_MICROVM_CAPABILITIES, RUN_CAPABILITY_VERSION, missingRunCapabilities, normalizeRunCapabilities } from './run-capabilities';
import { publicApiUrl } from '../config/instance';

/** One repo, one branch, at most one PR per run; mirrors the cloud-agent bound. */
export const RUN_TIMEOUT_MS = 50 * 60 * 1000;
export const RUN_TTL_SECONDS = 3600;
const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 3600;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
/** Prepare clones and stages the runner; launch only detaches it. Both fit the fleet exec budget. */
const PREPARE_TIMEOUT_SECONDS = 240;
const LAUNCH_TIMEOUT_SECONDS = 60;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Cheap pre-filter only; the real gate is the collaborator permission lookup.
const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const WRITE_PERMISSIONS = new Set(['write', 'maintain', 'admin']);
const INSTALL_STATE_TTL_SECONDS = 900;
const PICK_TTL_SECONDS = 600;
const MAX_CANDIDATES = 20;
const GITHUB_TIMEOUT_MS = 15_000;
const INSTALLATIONS_MAX_PAGES = 10;
const TERMINAL_COMPLETION = new Set(['fixed', 'no_change', 'failed']);
const FAILURE_TAXONOMY = new Set([
  'repro_failed',
  'tests_failed',
  'agent_timeout',
  'push_failed',
  'completion_lost',
  'empty_fix',
  'agent_unsupported',
  'no_test_command',
  'provider_not_configured',
  'token_mint_failed',
  'base_branch_not_found',
  'dock_provision_failed',
  'pr_create_failed',
  'timed_out',
  'clone_failed',
  'agent_failed',
  'agent_no_result',
  'runner_failed',
  'diff_too_large',
  'unsupported_change',
]);

export class InvalidSignatureException extends UnauthorizedException {
  constructor() {
    super({ code: 'invalid_signature', message: 'Invalid webhook signature' });
  }
}

export class RunNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'run_not_found', message: 'Run not found' });
  }
}

export class InstallationNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'installation_not_found', message: 'Installation not found' });
  }
}

export class InvalidCompletionTokenException extends UnauthorizedException {
  constructor() {
    super({ code: 'invalid_completion_token', message: 'Invalid completion token' });
  }
}

class InstallationNotAccessibleException extends ForbiddenException {
  constructor() {
    super({ code: 'installation_not_accessible', message: 'This installation cannot be linked' });
  }
}

class InvalidInstallStateException extends BadRequestException {
  constructor() {
    super({ code: 'invalid_state', message: 'Link state is unknown, expired, or not yours' });
  }
}

class SessionRequiredException extends ForbiddenException {
  constructor() {
    super({ code: 'session_required', message: 'This action requires an interactive browser session' });
  }
}

class RateLimitedException extends HttpException {
  constructor() {
    super({ code: 'rate_limited', message: 'GitHub run rate limit exceeded' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}
interface InstallAccount {
  type: string;
  id: number;
  login: string;
}
interface PendingLink {
  workspaceId: string;
  nonce: string;
  /** Installation ids the user already proved control of, awaiting a pick. */
  ids?: number[];
}
function parsePending(raw: string | null): PendingLink | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { workspaceId?: unknown; nonce?: unknown; ids?: unknown };
    if (typeof v.workspaceId !== 'string' || typeof v.nonce !== 'string') return null;
    return { workspaceId: v.workspaceId, nonce: v.nonce, ids: Array.isArray(v.ids) ? v.ids.filter((i): i is number => typeof i === 'number') : undefined };
  } catch {
    return null;
  }
}
const pendingKey = (userId: string): string => `gh:install:pending:${userId}`;
const pickKey = (userId: string): string => `gh:install:pick:${userId}`;
function checkedExecutionTarget(body: string): GithubExecutionTarget {
  const parsed = parseExecutionTarget(body);
  if (parsed === null) return 'dock';
  if (!(GITHUB_EXECUTION_TARGETS as readonly string[]).includes(parsed)) {
    throw validationError(`unknown execution target: ${parsed}`);
  }
  return parsed as GithubExecutionTarget;
}

export interface WebhookDeliveryInput {
  signature: string | string[] | undefined;
  deliveryGuid: string | undefined;
  hookId: string | undefined;
  event: string | undefined;
  rawBody: Buffer | string;
  body: unknown;
}

interface IssueCommentPayload {
  action?: unknown;
  installation?: { id?: unknown };
  sender?: { login?: unknown; id?: unknown };
  repository?: { full_name?: unknown; name?: unknown; default_branch?: unknown; owner?: { login?: unknown } };
  issue?: { number?: unknown; title?: unknown; body?: unknown; pull_request?: unknown } | null;
  pull_request?: unknown;
  comment?: { id?: unknown; body?: unknown; author_association?: unknown };
}

export interface ServiceOptions {
  timeoutMs?: number;
  leaseMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  completionTokenFn?: () => string;
  gatewayTokenFn?: () => string;
}

interface RunCredentials {
  /** Control-plane token for API reads; never enters a guest. */
  token: string;
  model: string;
  /** Set only when the model runs on this user's ChatGPT sign-in. */
  llmUserId: string | null;
}

/** Per-attempt secrets handed to the guest, each scoped to this run. */
interface LaunchSecrets {
  model: string;
  completionPlain: string;
  gatewayPlain: string;
  resumeBranch?: boolean;
}

/** Hosts a confined run may reach besides the control plane; RUN_EGRESS_ALLOW replaces it, `*` disables confinement. */
export const DEFAULT_RUN_EGRESS = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'index.crates.io',
  'static.crates.io',
];

/** One file in a fixed run's change set, relative to the start commit. */
export interface RunChange {
  path: string;
  mode?: '100644' | '100755' | '120000';
  content?: string;
  deleted?: boolean;
}

export interface CompleteRunInput {
  status: string;
  summary?: string;
  reason?: string;
  testOk?: boolean;
  parentSha?: string;
  commitMessage?: string;
  changes?: RunChange[];
}

/**
 * GitHub App issue-to-PR runs. Webhook intake verifies the App webhook
 * secret (single App-level secret, never the private key), claims the
 * delivery GUID, then works synchronously: mint token, pin base SHA,
 * render the task envelope, provision a dock with the POSIX runner, open
 * one draft PR, and wait for the dock-side phone-home callback.
 */
@Injectable()
export class GithubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GithubService.name);
  private readonly inflight = new Set<Promise<unknown>>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly completionTokenFn: () => string;
  private readonly gatewayTokenFn: () => string;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly docks: DocksService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Optional() options: ServiceOptions = {},
    @Optional() private readonly envs?: EnvironmentsService,
    @Optional() private readonly metering?: MeteringService,
    @Optional() private readonly spendGate?: SpendGate,
    @Optional() @Inject(FAST_RUN_PROVIDER) private readonly fastRuns?: FastRunProvider,
    @Optional() private readonly artifacts?: RunArtifactsService,
    @Optional() private readonly hosts?: HostsService,
    @Optional() private readonly chatgpt?: ChatgptService,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {
    this.timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    this.leaseMs = options.leaseMs ?? CLAIM_LEASE_MS;
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
    this.completionTokenFn = options.completionTokenFn ?? newToken;
    this.gatewayTokenFn = options.gatewayTokenFn ?? newToken;
  }

  private get appSlug(): string {
    return this.config.get<string>('GITHUB_APP_SLUG') ?? 'dock';
  }

  private callbackBase(): string {
    return this.config.get<string>('GITHUB_CALLBACK_BASE_URL') || publicApiUrl(this.config);
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      this.sweepTimeouts().catch((err) => this.logger.warn(`GitHub run sweep failed: ${(err as Error).message}`));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.settled();
  }

  // Installations

  private requireSession(user: RequestUser): void {
    if (user.isInteractive === false) throw new SessionRequiredException();
  }

  private async orgForWorkspace(workspaceId: string): Promise<string> {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) throw new InstallationNotFoundException();
    return ws.organizationId;
  }

  private checkedAgent(agent: string | undefined): string {
    const value = agent ?? 'opencode';
    if (!runAgentNames().includes(value)) throw validationError(`unknown agent: ${value}`);
    validateMappingAgent(value);
    return value;
  }

  private checkedTestCommand(cmd: string | undefined): string | null {
    if (cmd === undefined || cmd === null) return null;
    try {
      validateTestCommand(cmd);
    } catch (err) {
      throw validationError((err as Error).message);
    }
    return cmd;
  }

  /** Starts linking: one pending link per user, single use, rides the App install redirect. */
  async startInstallLink(user: RequestUser, workspaceId: string, mode: 'install' | 'authorize' = 'install') {
    this.requireSession(user);
    const orgId = await this.orgForWorkspace(workspaceId);
    await this.orgs.requireMembership(orgId, user.id, 'admin');
    const nonce = randomBytes(16).toString('hex');
    const redis = this.requireRedis();
    await redis.del(pickKey(user.id));
    await redis.set(pendingKey(user.id), JSON.stringify({ workspaceId, nonce }), 'EX', INSTALL_STATE_TTL_SECONDS);
    if (mode === 'authorize') {
      // An App already installed on the account never shows the install page; authorizing alone returns code and state.
      const clientId = this.config.get<string>('GITHUB_APP_CLIENT_ID');
      if (!clientId) throw this.oauthNotConfigured();
      return { url: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${nonce}`, state: nonce };
    }
    return { url: `https://github.com/apps/${encodeURIComponent(this.appSlug)}/installations/new?state=${nonce}`, state: nonce };
  }

  /**
   * Finishes linking from the App's OAuth callback. `state` is required; on an already-installed
   * account GitHub may omit `installationId`. With no installationId the
   * installations the user controls come back as candidates and a second call with just the pick links one.
   */
  async completeInstallLink(user: RequestUser, input: { installationId?: number; code?: string; state?: string }) {
    this.requireSession(user);
    const { installationId, code, state } = input;
    if (installationId !== undefined && (!Number.isInteger(installationId) || installationId < 1)) {
      throw validationError('installationId must be a positive integer');
    }
    const clientId = this.config.get<string>('GITHUB_APP_CLIENT_ID');
    const clientSecret = this.config.get<string>('GITHUB_APP_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw this.oauthNotConfigured();
    }
    const redis = this.requireRedis();
    if (!code) {
      if (installationId === undefined) throw validationError('code or installationId is required');
      const picked = parsePending(await redis.getdel(pickKey(user.id)));
      if (!picked?.ids?.includes(installationId)) throw new InvalidInstallStateException();
      await this.orgs.requireMembership(await this.orgForWorkspace(picked.workspaceId), user.id, 'admin');
      return this.linkInstallation(user, picked.workspaceId, installationId);
    }
    const bound = parsePending(await redis.getdel(pendingKey(user.id)));
    // State is mandatory so another user's OAuth code cannot complete into this pending link.
    if (!bound || !state || state !== bound.nonce) throw new InvalidInstallStateException();
    const orgId = await this.orgForWorkspace(bound.workspaceId);
    await this.orgs.requireMembership(orgId, user.id, 'admin');
    const identity = await this.githubIdentity(code, clientId, clientSecret);
    if (!identity) throw new InstallationNotAccessibleException();
    const listed = await this.userInstallations(identity.token);
    if (installationId !== undefined) {
      const mine = listed?.find((i) => i.id === installationId);
      const target = mine ? await this.installationAccount(installationId) : null;
      if (!target || !(await this.controlsAccount(identity, target))) throw new InstallationNotAccessibleException();
      return this.linkInstallation(user, bound.workspaceId, installationId);
    }
    const candidates: Array<{ installationId: number; account: string }> = [];
    const unlinked = await this.withoutLinked((listed ?? []).slice(0, MAX_CANDIDATES));
    for (const item of unlinked) {
      if (await this.controlsAccount(identity, item.account)) candidates.push({ installationId: item.id, account: item.account.login });
    }
    if (!candidates.length) throw new InstallationNotAccessibleException();
    if (candidates.length === 1) return this.linkInstallation(user, bound.workspaceId, candidates[0].installationId);
    await redis.set(
      pickKey(user.id),
      JSON.stringify({ ...bound, ids: candidates.map((x) => x.installationId) }),
      'EX',
      PICK_TTL_SECONDS,
    );
    return { candidates };
  }

  private async withoutLinked<T extends { id: number }>(items: T[]): Promise<T[]> {
    if (!items.length) return items;
    const rows = await this.db
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      .where(inArray(githubInstallations.installationId, items.map((i) => i.id)));
    const taken = new Set(rows.map((r) => r.installationId));
    return items.filter((i) => !taken.has(i.id));
  }

  private oauthNotConfigured(): HttpException {
    return new HttpException(
      { code: 'github_app_oauth_not_configured', message: 'Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET to link installations' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private async linkInstallation(user: RequestUser, workspaceId: string, installationId: number) {
    const repos = await this.installationRepos(installationId);
    try {
      const [row] = await this.db
        .insert(githubInstallations)
        .values({ installationId, workspaceId, createdBy: user.id, repos, agent: 'opencode', testCommand: null })
        .returning();
      return {
        id: row.id,
        installationId: row.installationId,
        workspaceId: row.workspaceId,
        repos: row.repos,
        agent: row.agent,
        testCommand: row.testCommand,
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Same error as an unknown installation so IDs cannot be enumerated.
      throw new InstallationNotAccessibleException();
    }
  }

  private requireRedis(): Redis {
    if (!this.redis) throw new HttpException({ code: 'unavailable', message: 'Link state store is unavailable' }, HttpStatus.SERVICE_UNAVAILABLE);
    return this.redis;
  }

  private appJwt(): string {
    return mintAppJwtWithRotation(
      this.config.get<string>('GITHUB_APP_ID') ?? '',
      this.config.get<string>('GITHUB_APP_PRIVATE_KEY') ?? '',
      this.config.get<string>('GITHUB_APP_PRIVATE_KEY_PREV') ?? '',
      this.now(),
    );
  }

  /** App-JWT lookup of the installation's account; null when this App has no such installation. */
  private async installationAccount(installationId: number): Promise<InstallAccount | null> {
    let res: Response;
    try {
      res = await (this.fetchFn ?? fetch)(`https://api.github.com/app/installations/${installationId}`, {
        headers: { authorization: `Bearer ${this.appJwt()}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BadGatewayException({ code: 'github_unavailable', message: `GitHub unreachable: ${(err as Error).message}` });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new BadGatewayException({ code: 'github_unavailable', message: `GitHub answered ${res.status}` });
    const data = (await res.json()) as { account?: { type?: unknown; id?: unknown; login?: unknown } | null };
    const acct = data.account;
    if (typeof acct?.type !== 'string' || typeof acct.id !== 'number' || typeof acct.login !== 'string') return null;
    return { type: acct.type, id: acct.id, login: acct.login };
  }

  private async githubGet(token: string, url: string): Promise<unknown> {
    const res = await (this.fetchFn ?? fetch)(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    return res.ok ? res.json() : null;
  }

  /** Exchanges the OAuth code for the user's identity. The user token is used in memory only, never stored. */
  private async githubIdentity(code: string, clientId: string, clientSecret: string): Promise<{ token: string; id: number } | null> {
    try {
      const exchanged = await (this.fetchFn ?? fetch)('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      const token = exchanged.ok ? ((await exchanged.json()) as { access_token?: unknown }).access_token : null;
      if (typeof token !== 'string' || !token) return null;
      const me = (await this.githubGet(token, 'https://api.github.com/user')) as { id?: unknown } | null;
      return typeof me?.id === 'number' ? { token, id: me.id } : null;
    } catch {
      return null;
    }
  }

  /** Installations of this App the user can see; null when the lookup fails. */
  private async userInstallations(token: string): Promise<Array<{ id: number; account: InstallAccount }> | null> {
    const out: Array<{ id: number; account: InstallAccount }> = [];
    try {
      for (let page = 1; page <= INSTALLATIONS_MAX_PAGES; page += 1) {
        const data = (await this.githubGet(token, `https://api.github.com/user/installations?per_page=100&page=${page}`)) as {
          installations?: Array<{ id?: unknown; account?: { type?: unknown; id?: unknown; login?: unknown } | null }>;
        } | null;
        if (!data) return null;
        const list = data.installations ?? [];
        for (const i of list) {
          const a = i.account;
          if (typeof i.id === 'number' && typeof a?.type === 'string' && typeof a.id === 'number' && typeof a.login === 'string') {
            out.push({ id: i.id, account: { type: a.type, id: a.id, login: a.login } });
          }
        }
        if (list.length < 100) break;
      }
    } catch {
      return null;
    }
    return out;
  }

  /** The user is the personal account, or an active admin of the organization. */
  private async controlsAccount(identity: { token: string; id: number }, account: InstallAccount): Promise<boolean> {
    if (account.type === 'User') return account.id === identity.id;
    if (account.type !== 'Organization') return false;
    try {
      const m = (await this.githubGet(identity.token, `https://api.github.com/user/memberships/orgs/${encodeURIComponent(account.login)}`)) as {
        state?: unknown;
        role?: unknown;
      } | null;
      return m?.state === 'active' && m.role === 'admin';
    } catch {
      return false;
    }
  }

  private async installationRepos(installationId: number): Promise<string[]> {
    try {
      const token = await this.mintInstallationToken(installationId, undefined, { metadata: 'read' });
      return await this.github.listInstallationRepositories({ token });
    } catch (err) {
      throw new BadGatewayException({ code: 'github_unavailable', message: `Could not list installation repositories: ${(err as Error).message}` });
    }
  }

  /** Canonical GitHub casing for each requested repo; refuses any the installation does not cover. */
  private async checkedRepos(installationId: number, requested: string[]): Promise<string[]> {
    const actual = new Map((await this.installationRepos(installationId)).map((r) => [r.toLowerCase(), r]));
    return requested.map((repo) => {
      const canonical = actual.get(repo.toLowerCase());
      if (!canonical) throw validationError(`repo is not part of this installation: ${repo}`);
      return canonical;
    });
  }

  async updateInstallation(user: RequestUser, id: string, patch: { repos?: string[]; agent?: string; testCommand?: string | null }) {
    this.requireSession(user);
    const [row] = await this.db.select().from(githubInstallations).where(eq(githubInstallations.id, id)).limit(1);
    if (!row) throw new InstallationNotFoundException();
    const orgId = await this.orgForWorkspace(row.workspaceId);
    await this.orgs.requireMembership(orgId, user.id, 'admin');
    const set: Partial<typeof githubInstallations.$inferInsert> = {};
    if (patch.repos !== undefined) set.repos = await this.checkedRepos(row.installationId, patch.repos);
    if (patch.agent !== undefined) set.agent = this.checkedAgent(patch.agent);
    if (patch.testCommand !== undefined) {
      set.testCommand = patch.testCommand === null ? null : this.checkedTestCommand(patch.testCommand);
    }
    if (!Object.keys(set).length) return row;
    const [updated] = await this.db.update(githubInstallations).set(set).where(eq(githubInstallations.id, id)).returning();
    return updated ?? row;
  }

  async listInstallations(callerId: string, workspaceId: string) {
    const orgId = await this.orgForWorkspace(workspaceId);
    await this.orgs.requireMembership(orgId, callerId);
    return this.db.select().from(githubInstallations).where(eq(githubInstallations.workspaceId, workspaceId));
  }

  async removeInstallation(user: RequestUser, id: string) {
    this.requireSession(user);
    const [row] = await this.db.select().from(githubInstallations).where(eq(githubInstallations.id, id)).limit(1);
    if (!row) throw new InstallationNotFoundException();
    const orgId = await this.orgForWorkspace(row.workspaceId);
    await this.orgs.requireMembership(orgId, user.id, 'admin');
    await this.db.delete(githubInstallations).where(eq(githubInstallations.id, id));
    return { deleted: true };
  }

  // Runs reads

  async listRuns(callerId: string, workspaceId: string, state?: GithubRunState) {
    const orgId = await this.orgForWorkspace(workspaceId);
    await this.orgs.requireMembership(orgId, callerId);
    const conditions = [eq(githubRuns.workspaceId, workspaceId)];
    if (state) {
      if (!GITHUB_RUN_STATES.includes(state)) throw validationError('Unknown run state');
      conditions.push(eq(githubRuns.state, state));
    }
    const rows = await this.db
      .select()
      .from(githubRuns)
      .where(and(...conditions))
      .orderBy(desc(githubRuns.createdAt));
    return rows.map(runView);
  }

  async getRun(callerId: string, id: string): Promise<RunView> {
    return runView(await this.loadRun(callerId, id));
  }

  private async loadRun(callerId: string, id: string): Promise<GithubRun> {
    const [run] = await this.db.select().from(githubRuns).where(eq(githubRuns.id, id)).limit(1);
    if (!run) throw new RunNotFoundException();
    try {
      const orgId = await this.orgForWorkspace(run.workspaceId);
      await this.orgs.requireMembership(orgId, callerId);
    } catch (err) {
      if (err instanceof NotFoundException) throw new RunNotFoundException();
      throw err;
    }
    return run;
  }

  /** Moves a live Fast Run onto a persistent dock that resumes the run branch. */
  async promoteRun(caller: RequestUser, id: string): Promise<RunView> {
    this.requireSession(caller);
    const run = await this.loadRun(caller.id, id);
    if (run.executionTarget !== 'fast') return runView(run);
    if (run.state === 'done' || run.state === 'failed' || run.state === 'stopped') {
      throw new ConflictException({ code: 'run_not_promotable', message: 'Terminal Runs cannot be promoted' });
    }
    if (!run.baseSha || !run.branch || !run.testCommand || !run.envelope) {
      throw new ConflictException({ code: 'run_not_promotable', message: 'Run envelope is incomplete' });
    }
    const [mapping] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, run.installationId))
      .limit(1);
    if (!mapping) throw new RunNotFoundException();
    if (this.spendGate && run.organizationId) {
      await this.spendGate.requireSpend(run.organizationId);
    }
    const credentials = await this.runCredentials(
      mapping,
      run.repo,
      run.organizationId ?? (await this.orgForWorkspace(run.workspaceId)),
      run.agent,
      run.llmUserId,
    );
    if (typeof credentials === 'string') {
      throw new ConflictException({ code: 'run_not_promotable', message: `Run cannot be promoted: ${credentials}` });
    }
    await this.finalizeRuntime(run);
    const completionPlain = this.completionTokenFn();
    const gatewayPlain = this.gatewayTokenFn();
    const promoted = await this.updateRun(
      run,
      {
        executionTarget: 'dock',
        attemptNumber: run.attemptNumber + 1,
        runtimeId: null,
        runtimeHostId: null,
        dockId: null,
        state: 'provisioning',
        artifactStatus: 'pending',
        artifactError: null,
        completionTokenHash: hashToken(completionPlain),
        gatewayTokenHash: hashToken(gatewayPlain),
        model: credentials.model,
        llmUserId: credentials.llmUserId,
        completionConsumed: false,
        completionStatus: null,
      },
      'run.promoted',
    );
    const payload: IssueCommentPayload = { issue: { number: run.issueNumber } };
    this.background(this.launch(promoted, mapping, payload, { model: credentials.model, completionPlain, gatewayPlain, resumeBranch: true }));
    return runView(promoted);
  }

  // Webhook intake

  async handleWebhookDelivery(input: WebhookDeliveryInput): Promise<{ status: number; body: unknown }> {
    const secret = this.config.get<string>('GITHUB_APP_WEBHOOK_SECRET') ?? '';
    const raw = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8');
    if (!verifyGithubSignature(secret, input.signature, raw)) throw new InvalidSignatureException();
    if (!input.deliveryGuid || !input.hookId || !input.event) {
      throw validationError('Webhook delivery needs event, GUID, and hook id');
    }
    const claim = await this.claimDelivery(input.hookId, input.deliveryGuid, input.event);
    if (claim.duplicate) {
      return { status: 200, body: { received: true, duplicate: true, runId: claim.runId ?? null } };
    }
    try {
      const out = await this.routeEvent(input.event, input.body);
      await this.markDelivery(claim.id, 'succeeded', out.runId);
      return { status: out.status, body: out.body };
    } catch (err) {
      if (err instanceof HttpException) {
        await this.markDelivery(claim.id, 'succeeded');
        throw err;
      }
      this.logger.warn(`GitHub delivery ${input.deliveryGuid} failed: ${(err as Error).message}`);
      await this.markDelivery(claim.id, 'failed', undefined, (err as Error).message);
      throw err;
    }
  }

  private async claimDelivery(
    hookId: string,
    deliveryGuid: string,
    event: string,
  ): Promise<{ id: string; duplicate: boolean; runId?: string | null }> {
    try {
      const [row] = await this.db
        .insert(githubWebhookDeliveries)
        .values({ hookId, deliveryGuid, event, status: 'received' })
        .returning();
      await this.db.update(githubWebhookDeliveries).set({ status: 'processing' }).where(eq(githubWebhookDeliveries.id, row.id));
      return { id: row.id, duplicate: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    const [existing] = await this.db
      .select()
      .from(githubWebhookDeliveries)
      .where(and(eq(githubWebhookDeliveries.hookId, hookId), eq(githubWebhookDeliveries.deliveryGuid, deliveryGuid)))
      .limit(1);
    if (!existing) return { id: '', duplicate: true };
    const stale =
      existing.status === 'processing' && this.now() - new Date(existing.updatedAt).getTime() > this.leaseMs;
    if (stale) {
      await this.db.update(githubWebhookDeliveries).set({ status: 'processing' }).where(eq(githubWebhookDeliveries.id, existing.id));
      return { id: existing.id, duplicate: false };
    }
    return { id: existing.id, duplicate: true, runId: existing.runId };
  }

  private async markDelivery(id: string, status: 'succeeded' | 'failed', runId?: string, error?: string): Promise<void> {
    if (!id) return;
    await this.db
      .update(githubWebhookDeliveries)
      .set({ status, runId, error: error?.slice(0, 1000) ?? null })
      .where(eq(githubWebhookDeliveries.id, id));
  }

  private async routeEvent(event: string, body: unknown): Promise<{ status: number; body: unknown; runId?: string }> {
    const payload = (body ?? {}) as IssueCommentPayload;
    if (event === 'installation' && (body as { action?: unknown })?.action === 'deleted') {
      const installationId = payload.installation?.id;
      if (typeof installationId === 'number') {
        await this.db.delete(githubInstallations).where(eq(githubInstallations.installationId, installationId));
      }
      return { status: 200, body: { received: true, ignored: true, reason: 'installation_deleted' } };
    }
    if (event !== 'issue_comment') {
      return { status: 200, body: { received: true, ignored: true, reason: 'unsupported_event' } };
    }
    return this.handleIssueComment(payload);
  }

  // Mention pipeline

  private async handleIssueComment(
    payload: IssueCommentPayload,
  ): Promise<{ status: number; body: unknown; runId?: string }> {
    const installationId = payload.installation?.id;
    const sender = typeof payload.sender?.login === 'string' ? payload.sender.login : undefined;
    const commentId = payload.comment?.id;
    const commentBody = typeof payload.comment?.body === 'string' ? payload.comment.body : '';
    const repoFull = typeof payload.repository?.full_name === 'string' ? payload.repository.full_name : undefined;
    if (typeof installationId !== 'number' || typeof commentId !== 'number' || !repoFull || payload.action !== 'created') {
      return { status: 200, body: { received: true, ignored: true, reason: 'not_a_mention_target' } };
    }
    const [mapping] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    if (!mapping || !mapping.repos.includes(repoFull)) {
      return { status: 200, body: { received: true, ignored: true, reason: 'unmapped_repo' } };
    }
    if (!isIssueTarget(payload)) {
      return { status: 200, body: { received: true, ignored: true, reason: 'pr_comment' } };
    }
    if (isAppSender(sender, this.appSlug)) {
      return { status: 200, body: { received: true, ignored: true, reason: 'self_comment' } };
    }
    if (!hasDockMention(commentBody)) {
      return { status: 200, body: { received: true, ignored: true, reason: 'no_mention' } };
    }
    // Fail closed: a missing or non-string association is never treated as a collaborator.
    const association = typeof payload.comment?.author_association === 'string' ? payload.comment.author_association : '';
    if (!WRITE_ASSOCIATIONS.has(association)) {
      return { status: 200, body: { received: true, ignored: true, reason: 'unprivileged_sender' } };
    }
    if (!(await this.senderCanWrite(mapping.installationId, repoFull, sender))) {
      return { status: 200, body: { received: true, ignored: true, reason: 'unprivileged_sender' } };
    }
    let orgId: string;
    try {
      orgId = await this.orgForWorkspace(mapping.workspaceId);
    } catch (err) {
      // Stale mapping whose workspace is gone: quiet ignore beats poison redeliveries.
      if (err instanceof InstallationNotFoundException) {
        this.logger.warn(`GitHub mapping ${mapping.id} points at a missing workspace; ignoring mention`);
        return { status: 200, body: { received: true, ignored: true, reason: 'workspace_gone' } };
      }
      throw err;
    }
    const hit = await this.limits.hit(`rl:github-run:${installationId}:${repoFull}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    if (!hit.allowed) {
      await this.commentBestEffort(mapping, repoFull, payload, `Rate limit reached for @${this.appSlug} in this repo. Try again later.`);
      throw new RateLimitedException();
    }
    const issueNumber = typeof payload.issue?.number === 'number' ? payload.issue.number : 0;
    const [active] = await this.db
      .select()
      .from(githubRuns)
      .where(
        and(
          eq(githubRuns.installationId, mapping.id),
          eq(githubRuns.repo, repoFull),
          eq(githubRuns.issueNumber, issueNumber),
          eq(githubRuns.state, 'pending'),
        ),
      )
      .limit(1);
    const busy =
      active ??
      (await this.activeIn(mapping.id, repoFull, issueNumber, ['provisioning', 'working'])) ??
      (await this.activeIn(mapping.id, repoFull, issueNumber, ['pr_opened'])) ??
      null;
    if (busy) {
      await this.commentBestEffort(mapping, repoFull, payload, `A @${this.appSlug} run is already working this issue (${busy.id}). Follow-ups belong on the pull request.`);
      return { status: 202, body: { received: true, busy: true, runId: busy.id }, runId: busy.id };
    }
    return this.startRun(mapping, orgId, repoFull, payload, issueNumber, commentId, commentBody);
  }

  /** Fails closed: a lookup error counts as no write access. */
  private async senderCanWrite(installationId: number, repoFull: string, sender: string | undefined): Promise<boolean> {
    if (!sender) return false;
    const [owner, repo] = repoFull.split('/');
    try {
      const token = await this.mintInstallationToken(installationId, repo, { metadata: 'read' });
      const { permission } = await this.github.getCollaboratorPermission({ token, owner, repo, username: sender });
      return WRITE_PERMISSIONS.has(permission);
    } catch (err) {
      this.logger.warn(`GitHub permission lookup failed for ${sender} on ${repoFull}: ${(err as Error).message}`);
      return false;
    }
  }

  private async activeIn(
    installationDbId: string,
    repo: string,
    issue: number,
    states: GithubRunState[],
  ): Promise<GithubRun | null> {
    for (const state of states) {
      const [row] = await this.db
        .select()
        .from(githubRuns)
        .where(
          and(
            eq(githubRuns.installationId, installationDbId),
            eq(githubRuns.repo, repo),
            eq(githubRuns.issueNumber, issue),
            eq(githubRuns.state, state),
          ),
        )
        .limit(1);
      if (row) return row;
    }
    return null;
  }

  private async startRun(
    mapping: typeof githubInstallations.$inferSelect,
    orgId: string,
    repoFull: string,
    payload: IssueCommentPayload,
    issueNumber: number,
    commentId: number,
    commentBody: string,
  ): Promise<{ status: number; body: unknown; runId: string }> {
    const [owner, repo] = repoFull.split('/');
    const defaultBranch = typeof payload.repository?.default_branch === 'string' ? payload.repository.default_branch : 'main';
    const baseBranch = parseBaseBranch(commentBody) ?? defaultBranch;
    const executionTarget = checkedExecutionTarget(commentBody);
    if (executionTarget === 'fast' && this.config.get<string>('FAST_RUN_ENABLED') !== 'true') {
      throw new HttpException(
        { code: 'fast_run_disabled', message: 'Fast Run is disabled for this deployment' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const requestedCapabilities = normalizeRunCapabilities(parseRunCapabilities(commentBody));
    const agent = mapping.agent ?? 'opencode';
    let run: GithubRun;
    try {
      const [row] = await this.db
        .insert(githubRuns)
        .values({
          installationId: mapping.id,
          workspaceId: mapping.workspaceId,
          organizationId: orgId,
          repo: repoFull,
          issueNumber,
          triggerCommentId: commentId,
          deliveryGuid: '',
          hookId: '',
          baseBranch,
          executionTarget,
          requestedCapabilities,
          state: 'pending',
          agent,
          events: [{ t: 'run.created', at: new Date(this.now()).toISOString() }],
        })
        .returning();
      run = row;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [existing] = await this.db
        .select()
        .from(githubRuns)
        .where(eq(githubRuns.triggerCommentId, commentId))
        .limit(1);
      return { status: 202, body: { received: true, duplicate: true, runId: existing?.id ?? null }, runId: existing?.id ?? '' };
    }
    if (this.now() - new Date(run.createdAt).getTime() > this.timeoutMs) {
      return this.failRun(run, mapping, payload, 'timed_out');
    }
    try {
      assertSupportedAgent(agent);
    } catch {
      return this.failRun(run, mapping, payload, 'agent_unsupported');
    }
    if (executionTarget === 'fast') {
      const missing = missingRunCapabilities(requestedCapabilities, FAST_MICROVM_CAPABILITIES);
      if (missing.length) {
        const failed = await this.updateRun(
          run,
          { state: 'failed', failureReason: `capability_unavailable: ${missing.join(',')}` },
          'run.capability_rejected',
        );
        await this.commentBestEffort(
          mapping,
          repoFull,
          payload,
          `Dock run ${failed.id} needs ${missing.join(', ')} which Fast Run does not offer. Mention @${this.appSlug} without \`fast\` to run on a persistent dock.`,
        );
        return { status: 202, body: { received: true, runId: failed.id, state: 'failed', reason: failed.failureReason }, runId: failed.id };
      }
    }
    const credentials = await this.runCredentials(mapping, repoFull, orgId, agent, await this.githubUser(payload.sender?.id));
    if (typeof credentials === 'string') return this.failRun(run, mapping, payload, credentials);
    const { token } = credentials;
    let headSha: string;
    try {
      headSha = (await this.github.getBranchHead({ token, owner, repo, branch: baseBranch })).sha;
    } catch {
      return this.failRun(run, mapping, payload, 'base_branch_not_found');
    }
    const testCommand = await this.resolveTestCommand(mapping, token, owner, repo, headSha);
    if (!testCommand) {
      return this.failRun(run, mapping, payload, 'no_test_command');
    }
    if (executionTarget === 'fast' && this.spendGate) {
      try {
        await this.spendGate.requireFastRunSpend(orgId, run.id);
      } catch (err) {
        const response = err instanceof HttpException ? err.getResponse() : null;
        const code =
          typeof response === 'object' &&
          response !== null &&
          'code' in response &&
          typeof response.code === 'string'
            ? response.code
            : 'fast_run_rejected';
        return this.failRun(run, mapping, payload, code);
      }
    }
    const branch = `dock/run-${run.id.slice(0, 8)}`;
    const timeoutMinutes = this.agentMinutes();
    const issueTitle = typeof payload.issue?.title === 'string' && payload.issue.title ? payload.issue.title : `issue #${issueNumber}`;
    const issueBody = typeof payload.issue?.body === 'string' ? payload.issue.body : '';
    const issueMd = renderIssueMd({ repo: repoFull, issueNumber, title: issueTitle, body: issueBody || commentBody, triggerComment: commentBody });
    const systemMd = renderSystemPrompt({ branch, baseSha: headSha, baseBranch, testCommand, timeoutMinutes, issueNumber });
    const constraintsMd = renderConstraintsMd({
      repo: repoFull,
      baseSha: headSha,
      baseBranch,
      branch,
      testCommand,
      timeoutMinutes,
      agent,
      promptVersion: PROMPT_VERSION,
    });
    const envelope = { issue: issueMd, system: systemMd, constraints: constraintsMd };
    const completionPlain = this.completionTokenFn();
    const gatewayPlain = this.gatewayTokenFn();
    const instructionFiles = await this.presentInstructionFiles(token, owner, repo, headSha);
    run = await this.updateRun(
      run,
      {
        state: 'provisioning',
        baseSha: headSha,
        branch,
        testCommand,
        promptVersion: PROMPT_VERSION,
        envelopeHash: envelopeHash(envelope),
        envelope,
        instructionFiles,
        completionTokenHash: hashToken(completionPlain),
        gatewayTokenHash: hashToken(gatewayPlain),
        model: credentials.model,
        llmUserId: credentials.llmUserId,
        completionConsumed: false,
        completionStatus: null,
      },
      'run.provisioning',
    );
    await this.commentBestEffort(
      mapping,
      repoFull,
      payload,
      `Dock run ${run.id} started on branch ${branch}. A pull request opens once a fix is pushed.`,
    );
    this.background(this.launch(run, mapping, payload, { model: credentials.model, completionPlain, gatewayPlain }));
    return { status: 202, body: { received: true, runId: run.id, state: run.state }, runId: run.id };
  }

  /** Agent budget leaves room for clone, provisioning, and the harness test run inside the run timeout. */
  private agentMinutes(): number {
    return Math.max(1, Math.round(this.timeoutMs / 60000) - 10);
  }

  /** Repo token, provider keys, and model for one attempt; a string is the failure reason. */
  private async runCredentials(
    mapping: typeof githubInstallations.$inferSelect,
    repoFull: string,
    orgId: string,
    agent: string,
    chatgptCandidate: string | null,
  ): Promise<RunCredentials | string> {
    let token: string;
    try {
      // Single-repo installation token; the App JWT never touches repo APIs.
      token = await this.mintInstallationToken(mapping.installationId, repoFull.split('/')[1]);
    } catch {
      return 'token_mint_failed';
    }
    const providerEnv = (await this.providerKeysForRun(orgId, agent)) ?? {};
    const llmUserId = await this.chatgptUser(chatgptCandidate, orgId);
    const model = selectRunModel(
      llmUserId ? { ...providerEnv, [CHATGPT_SESSION]: llmUserId } : providerEnv,
      this.config.get<string>('GITHUB_RUN_MODEL') || undefined,
      agent,
    );
    if (!model) return 'provider_not_configured';
    return { token, model, llmUserId: providerOf(model) === 'chatgpt' ? llmUserId : null };
  }

  /** Dock user who signed in with this GitHub account; null for commenters unknown to Dock. */
  private async githubUser(senderId: unknown): Promise<string | null> {
    if (!this.chatgpt?.enabled || typeof senderId !== 'number') return null;
    const [link] = await this.db
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, 'github'), eq(account.accountId, String(senderId))))
      .limit(1);
    return link?.userId ?? null;
  }

  /** A personal ChatGPT sign-in serves only its owner's runs, inside orgs they belong to. */
  private async chatgptUser(userId: string | null, orgId: string): Promise<string | null> {
    if (!userId || !this.chatgpt) return null;
    try {
      await this.orgs.requireMembership(orgId, userId);
    } catch {
      return null;
    }
    return (await this.chatgpt.usable(userId)) ? userId : null;
  }

  /** Background work outlives the webhook request; failures are logged, the sweep is the backstop. */
  private background(work: Promise<unknown>): void {
    const tracked = work
      .catch((err) => this.logger.warn(`GitHub run background step failed: ${(err as Error).message}`))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Resolves when background launches and finalizers settle. Tests and shutdown only. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /**
   * Boots a confined runtime, clones with a read-only token in one exec,
   * then detaches the runner in a second; the runner reports through
   * completeRun and never holds a GitHub credential or provider key.
   */
  private async launch(
    run: GithubRun,
    mapping: typeof githubInstallations.$inferSelect,
    payload: IssueCommentPayload,
    secrets: LaunchSecrets,
  ): Promise<void> {
    const fast = run.executionTarget === 'fast';
    if (!this.fastRuns) {
      await this.failRun(run, mapping, payload, 'runtime_unavailable');
      return;
    }
    if (!run.baseSha || !run.branch || !run.testCommand || !run.envelope) {
      await this.failRun(run, mapping, payload, 'dock_provision_failed');
      return;
    }
    const prepare = buildPrepareScript({
      repoFull: run.repo,
      baseBranch: run.baseBranch,
      baseSha: run.baseSha,
      branch: run.branch,
      issueNumber: run.issueNumber,
      callbackUrl: `${this.callbackBase()}/v1/github/runs/${run.id}/complete`,
      timeoutMinutes: this.agentMinutes(),
      testCommand: run.testCommand,
      model: secrets.model,
      agent: run.agent,
      gatewayUrl: `${this.callbackBase()}/v1/llm/${providerOf(secrets.model)}`,
      presentInstructionFiles: run.instructionFiles,
      resumeBranch: secrets.resumeBranch,
      envelope: run.envelope,
    });
    try {
      assertRunnerFits(prepare);
    } catch {
      await this.failRun(run, mapping, payload, 'dock_provision_failed');
      return;
    }
    let ref: RuntimeRef;
    try {
      ref = fast ? await this.createFastRuntime(run) : await this.createRunDock(run, mapping);
    } catch (err) {
      this.logger.warn(`Runtime for run ${run.id} failed to start: ${(err as Error).message}`);
      await this.failRun(run, mapping, payload, fast ? 'fast_runtime_create_failed' : 'dock_provision_failed');
      return;
    }
    run = await this.updateRun(
      run,
      fast
        ? { runtimeId: ref.runtimeId, runtimeHostId: ref.hostId, state: 'working' }
        : { dockId: ref.runtimeId, runtimeHostId: ref.hostId, state: 'working' },
      fast ? 'run.fast_ready' : 'run.dock_ready',
    );
    if (fast && this.metering && run.organizationId) {
      await this.metering.openFastRunWindow({
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        runtimeId: ref.runtimeId,
      });
    }
    let cloneToken: string;
    try {
      cloneToken = await this.mintInstallationToken(mapping.installationId, run.repo.split('/')[1], { contents: 'read' });
    } catch {
      await this.failRun(run, mapping, payload, 'token_mint_failed');
      return;
    }
    try {
      const out = await this.fastRuns.exec(ref, prepare, PREPARE_TIMEOUT_SECONDS, `run:${run.id}:prepare:${run.attemptNumber}`, {
        GITHUB_CLONE_TOKEN: cloneToken,
      });
      if (out.exitCode !== 0) throw new Error(`prepare exited ${out.exitCode}: ${out.stderr.slice(-300)}`);
    } catch (err) {
      this.logger.warn(`Runner prepare for run ${run.id} failed: ${(err as Error).message}`);
      await this.failRun(run, mapping, payload, 'clone_failed');
      return;
    }
    try {
      const out = await this.fastRuns.exec(ref, buildLaunchScript(), LAUNCH_TIMEOUT_SECONDS, `run:${run.id}:launch:${run.attemptNumber}`, {
        GITHUB_COMPLETION_TOKEN: secrets.completionPlain,
        DOCK_LLM_TOKEN: secrets.gatewayPlain,
      });
      if (out.exitCode !== 0) throw new Error(`launch exited ${out.exitCode}: ${out.stderr.slice(0, 200)}`);
    } catch (err) {
      this.logger.warn(`Runner launch for run ${run.id} failed: ${(err as Error).message}`);
      await this.failRun(run, mapping, payload, 'launch_failed');
      return;
    }
    await this.updateRun(run, {}, 'run.launched');
  }

  /** Allowlist for confined runs; null leaves egress open (`RUN_EGRESS_ALLOW=*`). */
  private egressAllow(): string[] | null {
    const raw = this.config.get<string>('RUN_EGRESS_ALLOW')?.trim();
    if (raw === '*') return null;
    const hosts = raw ? raw.split(',').map((h) => h.trim()).filter(Boolean) : [...DEFAULT_RUN_EGRESS];
    return [...new Set([...hosts, new URL(this.callbackBase()).hostname])];
  }

  private async createFastRuntime(run: GithubRun): Promise<RuntimeRef> {
    if (!this.fastRuns) throw new Error('fast runtime unavailable');
    const resources = { cpus: DEFAULT_CPUS, memoryMiB: DEFAULT_MEMORY_MIB, diskGiB: DEFAULT_DISK_GIB };
    let hostId: string | null = null;
    if (this.config.get<string>('RUNTIME_DRIVER') === 'restate') {
      const host = await this.hosts?.placeForDock({ cpus: resources.cpus, memoryMiB: resources.memoryMiB });
      if (!host) throw new Error('no host capacity for fast run');
      hostId = host.id;
    }
    const handle = await this.fastRuns.create({
      runtimeId: run.id,
      hostId,
      resources,
      image: DEFAULT_IMAGE,
      egressAllow: this.egressAllow() ?? undefined,
      capabilities: {
        version: RUN_CAPABILITY_VERSION,
        target: 'fast',
        profile: 'warm-microvm',
        capabilities: FAST_MICROVM_CAPABILITIES,
      },
    });
    return { hostId: handle.hostId ?? hostId, runtimeId: handle.runtimeId };
  }

  private async createRunDock(run: GithubRun, mapping: typeof githubInstallations.$inferSelect): Promise<RuntimeRef> {
    const dock = await this.docks.create(
      mapping.createdBy,
      { workspaceId: run.workspaceId, ttlSeconds: RUN_TTL_SECONDS, egressAllow: this.egressAllow() ?? undefined },
      `run:${run.id}:provision:${run.attemptNumber}`,
    );
    return { hostId: dock.hostId ?? null, runtimeId: dock.id };
  }

  private async resolveTestCommand(
    mapping: typeof githubInstallations.$inferSelect,
    token: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<string | null> {
    if (mapping.testCommand) {
      try {
        validateTestCommand(mapping.testCommand);
      } catch {
        return null;
      }
      return mapping.testCommand;
    }
    const instructionTexts: string[] = [];
    for (const file of REPO_INSTRUCTION_FILES) {
      const content = await this.readRepoFile(token, owner, repo, file, ref);
      if (content) instructionTexts.push(content);
    }
    const manifests = {
      packageJson: (await this.readRepoFile(token, owner, repo, 'package.json', ref)) !== null,
      bunLock: (await this.readRepoFile(token, owner, repo, 'bun.lock', ref)) !== null,
      requirementsTxt: (await this.readRepoFile(token, owner, repo, 'requirements.txt', ref)) !== null,
      pyprojectToml: (await this.readRepoFile(token, owner, repo, 'pyproject.toml', ref)) !== null,
      goMod: (await this.readRepoFile(token, owner, repo, 'go.mod', ref)) !== null,
      cargoToml: (await this.readRepoFile(token, owner, repo, 'Cargo.toml', ref)) !== null,
    };
    return autoDetectTestCommand(manifests, instructionTexts);
  }

  private async presentInstructionFiles(token: string, owner: string, repo: string, ref: string): Promise<string[]> {
    const present: string[] = [];
    for (const file of REPO_INSTRUCTION_FILES) {
      if ((await this.readRepoFile(token, owner, repo, file, ref)) !== null) present.push(file);
    }
    return present;
  }

  private async readRepoFile(token: string, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const api = this.github as Partial<GithubApi>;
      if (!api.getRepoFile) return null;
      const out = await api.getRepoFile({ token, owner, repo, path, ref });
      return out?.content ?? null;
    } catch {
      return null;
    }
  }

  /** Provider keys flow only through the environment bundle; withheld keys fail fast. */
  private async providerKeysForRun(orgId: string, agent: string): Promise<Record<string, string> | null> {
    if (!this.envs) return {};
    const required = requiredKeysFor([agent]);
    try {
      const bundle = await this.envs.resolveBundle(orgId, undefined, { agents: [agent] });
      if (required.length > 0 && !required.some((key) => bundle.vars[key])) return null;
      return bundle.vars;
    } catch {
      return null;
    }
  }

  // Completion callback

  private bearerToken(auth: string | string[] | undefined): string | null {
    const first = Array.isArray(auth) ? auth[0] : auth;
    if (typeof first !== 'string') return null;
    const match = /^Bearer (.+)$/.exec(first.trim());
    return match ? match[1].trim() : null;
  }

  private tokensEqual(provided: string, storedHash: string): boolean {
    let candidate: string;
    try {
      candidate = hashToken(provided);
    } catch {
      return false;
    }
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(storedHash, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Claims the single-use completion atomically, answers at once, and does
   * the GitHub work in the background: a slow commit never makes the guest
   * retry into a second one.
   */
  async completeRun(runId: string, auth: string | string[] | undefined, input: CompleteRunInput) {
    const [run] = await this.db.select().from(githubRuns).where(eq(githubRuns.id, runId)).limit(1);
    if (!run || !run.completionTokenHash) throw new InvalidCompletionTokenException();
    const provided = this.bearerToken(auth);
    if (!provided || !this.tokensEqual(provided, run.completionTokenHash)) throw new InvalidCompletionTokenException();
    if (!TERMINAL_COMPLETION.has(input.status)) throw validationError('Completion status must be fixed, no_change, or failed');
    const replay = (current: GithubRun): GithubRun => {
      if (current.completionStatus === input.status) return current;
      throw new InvalidCompletionTokenException();
    };
    if (run.completionConsumed) return replay(run);
    if (run.state === 'done' || run.state === 'failed' || run.state === 'stopped') {
      throw new InvalidCompletionTokenException();
    }
    const [mapping] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, run.installationId))
      .limit(1);
    if (!mapping) throw new RunNotFoundException();
    const [claimed] = await this.db
      .update(githubRuns)
      .set({ completionConsumed: true, completionStatus: input.status, updatedAt: new Date(this.now()) })
      .where(and(eq(githubRuns.id, run.id), eq(githubRuns.completionConsumed, false)))
      .returning();
    if (!claimed) {
      const [current] = await this.db.select().from(githubRuns).where(eq(githubRuns.id, run.id)).limit(1);
      return replay(current ?? run);
    }
    this.background(this.finishCompletion(claimed, mapping, input));
    return claimed;
  }

  private async finishCompletion(run: GithubRun, mapping: typeof githubInstallations.$inferSelect, input: CompleteRunInput): Promise<void> {
    const payload: IssueCommentPayload = { issue: { number: run.issueNumber } };
    let finished: GithubRun;
    if (input.status === 'fixed') {
      finished = await this.completeFixed(run, mapping, payload, input);
    } else if (input.status === 'no_change') {
      finished = await this.updateRun(run, { state: 'done' }, 'run.completed');
      await this.commentBestEffort(
        mapping,
        run.repo,
        payload,
        `Dock run ${run.id} finished with no change: ${input.summary ?? input.reason ?? 'nothing to fix'}.`,
      );
    } else {
      const reason = input.reason && FAILURE_TAXONOMY.has(input.reason) ? input.reason : 'failed';
      finished = await this.updateRun(run, { state: 'failed', failureReason: reason }, 'run.failed');
      await this.commentBestEffort(mapping, run.repo, payload, `Dock run ${run.id} failed: ${reason}${input.summary ? ` — ${input.summary}` : ''}.`);
    }
    await this.finalizeRuntime(finished);
  }

  /**
   * Commits the guest's change set on the run branch through the Git Data
   * API with a control-plane token, then opens the PR, draft unless the
   * harness tests passed. The guest never holds a write credential.
   */
  private async completeFixed(
    run: GithubRun,
    mapping: typeof githubInstallations.$inferSelect,
    payload: IssueCommentPayload,
    input: CompleteRunInput,
  ): Promise<GithubRun> {
    const fail = async (reason: string, message: string): Promise<GithubRun> => {
      const failed = await this.updateRun(run, { state: 'failed', failureReason: reason }, 'run.failed');
      await this.commentBestEffort(mapping, run.repo, payload, message);
      return failed;
    };
    const changes = input.changes ?? [];
    if (!changes.length || !input.parentSha) {
      return fail('empty_fix', `Dock run ${run.id} reported fixed but changed no files: empty_fix.`);
    }
    if (changes.some((c) => !safeRepoPath(c.path))) {
      return fail('unsupported_change', `Dock run ${run.id} touched paths outside the work tree: unsupported_change.`);
    }
    const [owner, repo] = run.repo.split('/');
    let token: string;
    try {
      token = await this.mintInstallationToken(mapping.installationId, repo);
    } catch {
      return fail('token_mint_failed', `Dock run ${run.id} failed: token_mint_failed.`);
    }
    const branch = run.branch ?? `dock/run-${run.id.slice(0, 8)}`;
    let branchHead: string | null = null;
    try {
      branchHead = (await this.github.getBranchHead({ token, owner, repo, branch })).sha;
    } catch {
      branchHead = null;
    }
    if (input.parentSha !== (branchHead ?? run.baseSha)) {
      return fail('push_failed', `Dock run ${run.id} started from ${input.parentSha.slice(0, 7)} but ${branch} moved: push_failed.`);
    }
    const summary = input.summary?.trim() || 'Automated fix.';
    let message = '';
    try {
      const { treeSha } = await this.github.getCommitTree({ token, owner, repo, sha: input.parentSha });
      const entries: GitTreeEntry[] = [];
      for (const change of changes) {
        if (change.deleted) {
          entries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const blob = await this.github.createBlob({ token, owner, repo, contentBase64: change.content ?? '' });
        entries.push({ path: change.path, mode: change.mode ?? '100644', type: 'blob', sha: blob.sha });
      }
      const tree = await this.github.createTree({ token, owner, repo, baseTree: treeSha, entries });
      message = input.commitMessage?.trim() || `Fix #${run.issueNumber}: ${summary.split('\n')[0]}`;
      const commit = await this.github.createCommit({ token, owner, repo, message, tree: tree.sha, parents: [input.parentSha] });
      await this.github.setBranch({ token, owner, repo, branch, sha: commit.sha, create: branchHead === null });
    } catch (err) {
      this.logger.warn(`Commit for run ${run.id} failed: ${(err as Error).message}`);
      return fail('push_failed', `Dock run ${run.id} could not commit to ${branch}: push_failed.`);
    }
    const testsPassed = input.testOk === true;
    const testEvidence = testsPassed ? 'harness: test command passed' : input.testOk === false ? 'harness: test command failed' : 'harness: test evidence unavailable';
    const body = [
      `Fixes #${run.issueNumber}`,
      '',
      summary,
      '',
      `${testEvidence} (\`${run.testCommand ?? 'unknown'}\`)`,
      '',
      `Initiator: ${mapping.createdBy} | Agent: dock-fix[bot] | Prompt: ${run.promptVersion ?? PROMPT_VERSION} | Run: ${run.id}`,
    ].join('\n');
    let pr: { number: number; url: string };
    try {
      pr = await this.github.createPullRequest({
        token,
        owner,
        repo,
        head: branch,
        base: run.baseBranch,
        title: `[dock] ${message.split('\n')[0].slice(0, 200)}`,
        body,
        draft: !testsPassed,
      });
    } catch (err) {
      this.logger.warn(`PR create for run ${run.id} failed: ${(err as Error).message}`);
      return fail('pr_create_failed', `Dock run ${run.id} pushed ${branch} but could not open a pull request: pr_create_failed.`);
    }
    const done = await this.updateRun(run, { state: 'done', prNumber: pr.number, prUrl: pr.url }, 'run.completed');
    await this.commentBestEffort(
      mapping,
      run.repo,
      payload,
      testsPassed
        ? `Fix ready for review: ${pr.url}`
        : `Draft fix opened: ${pr.url} (${testEvidence}).`,
    );
    return done;
  }

  /** Timeout sweep: runs silent past their timeout since the last event fail as completion_lost. */
  async sweepTimeouts(): Promise<{ swept: number }> {
    const cutoff = new Date(this.now() - this.timeoutMs);
    const stale = await this.db
      .select()
      .from(githubRuns)
      .where(and(inArray(githubRuns.state, ['provisioning', 'working', 'pr_opened']), lt(githubRuns.updatedAt, cutoff)));
    let swept = 0;
    for (const run of stale) {
      const [mapping] = await this.db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, run.installationId))
        .limit(1);
      if (!mapping) continue;
      const payload: IssueCommentPayload = { issue: { number: run.issueNumber } };
      await this.failRun(run, mapping, payload, 'completion_lost');
      swept += 1;
    }
    return { swept };
  }

  private async mintInstallationToken(
    installationId: number,
    repo: string | undefined,
    permissions?: Record<string, 'read' | 'write'>,
  ): Promise<string> {
    const repoName = repo?.includes('/') ? repo.split('/')[1] : repo;
    const out = await exchangeInstallationToken({
      apiBase: 'https://api.github.com',
      jwt: this.appJwt(),
      installationId,
      repositories: repoName ? [repoName] : undefined,
      permissions,
      fetchFn: this.fetchFn,
    });
    return out.token;
  }

  private async commentBestEffort(
    mapping: { installationId: number },
    repoFull: string,
    payload: IssueCommentPayload,
    body: string,
  ): Promise<void> {
    try {
      const [owner, repo] = repoFull.split('/');
      const issue = typeof payload.issue?.number === 'number' ? payload.issue.number : 0;
      if (!issue) return;
      const token = await this.mintInstallationToken(mapping.installationId, repo);
      await this.github.createIssueComment({ token, owner, repo, issue, body });
    } catch (err) {
      this.logger.warn(`GitHub comment dropped for ${repoFull}: ${(err as Error).message}`);
    }
  }

  private async updateRun(
    run: GithubRun,
    patch: Partial<typeof githubRuns.$inferInsert>,
    event: string,
  ): Promise<GithubRun> {
    const at = new Date(this.now());
    const events = [...run.events, { t: event, at: at.toISOString() }];
    const [row] = await this.db
      .update(githubRuns)
      .set({ ...patch, events, updatedAt: at })
      .where(eq(githubRuns.id, run.id))
      .returning();
    return row ?? { ...run, ...patch, events } as GithubRun;
  }

  private async failRun(
    run: GithubRun,
    mapping: { installationId: number; createdBy: string },
    payload: IssueCommentPayload,
    reason: string,
  ): Promise<{ status: number; body: unknown; runId: string }> {
    const failed = await this.updateRun(run, { state: 'failed', failureReason: reason }, 'run.failed');
    await this.commentBestEffort(mapping, failed.repo, payload, `Dock run ${failed.id} failed: ${reason}.`);
    await this.finalizeRuntime(failed);
    return { status: 202, body: { received: true, runId: failed.id, state: 'failed', reason }, runId: failed.id };
  }

  /** Publishes guest evidence, then releases the runtime: Fast Runs terminate, run docks stop. */
  private async finalizeRuntime(run: GithubRun): Promise<void> {
    const ref = runtimeRef(run);
    if (ref && this.fastRuns && this.artifacts) {
      try {
        const files = await this.fastRuns.collectArtifacts(
          ref,
          RUN_ARTIFACT_FILES.map((f) => `${RUN_ARTIFACT_DIR}/${f}`),
          `run:${run.id}:artifacts:${run.attemptNumber}`,
        );
        await this.artifacts.publish(run.id, files);
        await this.updateRun(run, { artifactStatus: 'published', artifactError: null }, 'run.artifacts_published');
      } catch (err) {
        await this.updateRun(run, { artifactStatus: 'failed', artifactError: (err as Error).message.slice(0, 500) }, 'run.artifacts_failed');
      }
    }
    if (run.dockId) {
      const [mapping] = await this.db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, run.installationId))
        .limit(1);
      try {
        await this.docks.stop(mapping?.createdBy ?? '', run.dockId, {});
      } catch (err) {
        this.logger.warn(`Dock stop dropped for run ${run.id}: ${(err as Error).message}`);
      }
    }
    if (run.executionTarget === 'fast' && run.runtimeId) {
      if (this.fastRuns) {
        try {
          await this.fastRuns.terminate({ hostId: run.runtimeHostId, runtimeId: run.runtimeId }, `run:${run.id}:terminate`);
          await this.recordCleanupEvent(run, true);
        } catch (err) {
          this.logger.warn(`Fast runtime cleanup dropped for ${run.id}: ${(err as Error).message}`);
          await this.recordCleanupEvent(run, false);
        }
      }
      if (this.metering) {
        try {
          await this.metering.closeWindowsForRuntime(run.runtimeId);
        } catch (err) {
          this.logger.warn(`Fast billing close dropped for run ${run.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async recordCleanupEvent(run: GithubRun, confirmed: boolean): Promise<void> {
    try {
      await this.updateRun(run, {}, confirmed ? 'run.cleanup_confirmed' : 'run.cleanup_failed');
    } catch (err) {
      this.logger.warn(`Fast cleanup event dropped for ${run.id}: ${(err as Error).message}`);
    }
  }
}

/** Exec target for a run: the Fast Run runtime, or the agent-enabled run dock. */
function runtimeRef(run: GithubRun): RuntimeRef | null {
  if (run.executionTarget === 'fast' && run.runtimeId) return { hostId: run.runtimeHostId, runtimeId: run.runtimeId };
  if (run.dockId) return { hostId: run.runtimeHostId, runtimeId: run.dockId };
  return null;
}

/** Repo-relative paths only: no absolute, parent, empty, or .git segments. */
function safeRepoPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.length > 4096) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git');
}
