import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { CHATGPT_DOCK_AGENTS } from '../chatgpt/chatgpt-dock';
import { ChatgptService } from '../chatgpt/chatgpt.service';
import { DEFAULT_DOCK_AGENTS, requiredKeysFor } from '../github/run-agents';
import {
  ENV_NAME_RE,
  ENV_PROVIDERS,
  SECRETS_ACCESS,
  docks,
  environmentVersions,
  environments,
  githubInstallations,
  workspaces,
  type EnvProvider,
  type EnvRepo,
  type EnvSecretFile,
  type SecretsAccess,
  type Environment,
  type EnvironmentVersion,
  type SealedValue,
} from '../database/schema';
import { DockNotFoundException } from '../docks/dock-errors';
import {
  OrganizationNotFoundException,
  OrganizationsService,
  isUniqueViolation,
  type OrgTx,
} from '../organizations/organizations.service';
import { OperationsService, type OperationView } from '../retention/operations.service';
import {
  FULL_NAME_RE,
  MAX_BRANCH_LENGTH,
  MAX_SECRET_FILE_BYTES,
  MAX_SECRET_FILES,
  MAX_SECRET_FILES_BYTES,
  MAX_SETUP_SCRIPT_BYTES,
  assertEnvKey,
  assertEnvMap,
  assertNotReserved,
  assertSecretPath,
  parseEnvContents,
  serializeEnvContents,
} from './env-validation';
import { openValue, sealValue } from './secrets';
import { AgentCredentialsService } from '../agent-credentials/agent-credentials.service';
import { type ProviderName } from '../database/schema/agent-credentials';

export class EnvironmentNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'environment_not_found', message: 'Environment not found' });
  }
}

export class EnvironmentSecretsAdminOnlyException extends ForbiddenException {
  constructor() {
    super({
      code: 'environment_secrets_admin_only',
      message:
        'This environment passes secrets, files or credentials into docks and only organization admins may launch such docks. Ask an admin, or choose an environment that does not restrict secrets.',
    });
  }
}

export class EnvironmentNameTakenException extends ConflictException {
  constructor() {
    super({ code: 'environment_name_taken', message: 'Environment name is taken' });
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_PIN_RE = /^v(\d+)$/;

export interface ConnectionView {
  connected: boolean;
}

export interface EnvironmentView {
  id: string;
  organizationId: string;
  name: string;
  isDefault: boolean;
  currentVersion: number;
  secretsAccess: SecretsAccess;
  safeForThirdParties: boolean;
  passGithub: boolean;
  passSecrets: boolean;
  passDockCredentials: boolean;
  passAgentsCredentials: boolean;
  connections: Record<EnvProvider, ConnectionView>;
  varNames: string[];
  files: { path: string; size: number }[];
  repos: {
    id: string;
    provider: EnvProvider;
    repositoryId: string;
    fullName: string;
    baseBranch: string | null;
    hasSetupScript: boolean;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentVersionView {
  version: number;
  createdAt: Date;
  dockCount: number;
}

export interface RevealedSecrets {
  envContents: string;
  secretFiles: { path: string; size: number; contents: string }[];
}

/** Driver-facing bundle: merged vars, decrypted files, and cloned repos. */
export interface ResolvedBundle {
  version: number;
  vars: Record<string, string>;
  files: { path: string; size: number; contents: string }[];
  repos: EnvRepo[];
  /** Provider names the platform filled; values never recorded, only names. */
  injectedProviders: ProviderName[];
  /** Whether the dock may hold an API credential acting as its creator. */
  passDockCredentials: boolean;
  /** Whether agent credentials (platform keys, the creator's ChatGPT sign-in) may reach the dock. */
  passAgentsCredentials: boolean;
}

export interface UpdateEnvironmentInput {
  name?: string;
  isDefault?: boolean;
  secretsAccess?: SecretsAccess;
  safeForThirdParties?: boolean;
  passGithub?: boolean;
  passSecrets?: boolean;
  passDockCredentials?: boolean;
  passAgentsCredentials?: boolean;
}

export interface AddRepoInput {
  provider: EnvProvider;
  repositoryId: string;
  fullName: string;
  baseBranch?: string;
  setupScript?: string;
}

export interface BulkSecretsInput {
  envContents?: string;
  secretFiles?: { path: string; contents: string }[];
}

interface VersionContent {
  safeForThirdParties: boolean;
  passGithub: boolean;
  passSecrets: boolean;
  passDockCredentials: boolean;
  passAgentsCredentials: boolean;
  repos: EnvRepo[];
  envVars: Record<string, SealedValue>;
  secretFiles: EnvSecretFile[];
}

/**
 * Versioned policy bundles docks inherit at start. Writes need admin;
 * every content save mints an immutable version, renames do not.
 */
@Injectable()
export class EnvironmentsService {
  private readonly key: Buffer;
  private readonly githubAppConfigured: boolean;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly ops: OperationsService,
    config: ConfigService,
    private readonly creds: AgentCredentialsService,
    @Optional() private readonly chatgpt?: ChatgptService,
  ) {
    this.key = Buffer.from(config.getOrThrow<string>('SECRETS_ENCRYPTION_KEY'), 'hex');
    this.githubAppConfigured = Boolean(config.get<string>('GITHUB_APP_ID') && config.get<string>('GITHUB_APP_PRIVATE_KEY'));
  }

  async listByOrg(callerId: string, orgId: string): Promise<EnvironmentView[]> {
    await this.orgs.requireMembership(orgId, callerId);
    let rows = await this.liveEnvironments(orgId);
    if (!rows.length) {
      await this.ensureBase(orgId);
      rows = await this.liveEnvironments(orgId);
    }
    const connections = await this.connectionStatus(orgId);
    const views: EnvironmentView[] = [];
    for (const env of rows) {
      views.push(this.toView(env, await this.latestVersion(env.id), connections));
    }
    return views;
  }

  async create(callerId: string, orgId: string, rawName: string, secretsAccess: SecretsAccess = 'admins'): Promise<EnvironmentView> {
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    const name = this.checkedName(rawName);
    if (!(SECRETS_ACCESS as readonly string[]).includes(secretsAccess)) throw validationError('secretsAccess must be members or admins');
    try {
      const env = await this.db.transaction(async (tx) => {
        // Deleted environments keep their row; a new one may reuse the name.
        await tx
          .delete(environments)
          .where(and(eq(environments.organizationId, orgId), eq(environments.name, name), isNotNull(environments.deletedAt)));
        const [row] = await tx
          .insert(environments)
          .values({ organizationId: orgId, name, secretsAccess })
          .returning();
        await tx
          .insert(environmentVersions)
          .values({ environmentId: row.id, version: 1, repos: [], envVars: {}, secretFiles: [] });
        return row;
      });
      return this.toView(env, await this.latestVersion(env.id), await this.connectionStatus(orgId));
    } catch (err) {
      if (isUniqueViolation(err)) throw new EnvironmentNameTakenException();
      throw err;
    }
  }

  async getByRef(callerId: string, ref: string, organizationId?: string): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'member');
    return this.toView(env, await this.latestVersion(env.id), await this.connectionStatus(env.organizationId));
  }

  async update(
    callerId: string,
    ref: string,
    organizationId: string | undefined,
    patch: UpdateEnvironmentInput,
  ): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    if (patch.isDefault === false && env.isDefault) {
      throw validationError('Make another environment the default instead');
    }
    const renamed = patch.name !== undefined && patch.name.trim() !== env.name;
    const posture = this.checkedPosture(patch);
    if (patch.secretsAccess !== undefined && !(SECRETS_ACCESS as readonly string[]).includes(patch.secretsAccess)) {
      throw validationError('secretsAccess must be members or admins');
    }
    const accessPatch = patch.secretsAccess;
    if (!renamed && patch.isDefault === undefined && !posture && accessPatch === undefined) return this.viewOf(env);
    try {
      const updated = await this.db.transaction(async (tx) => {
        let row = env;
        if (renamed || patch.isDefault !== undefined || accessPatch !== undefined) {
          const set: Partial<typeof environments.$inferInsert> = { updatedAt: new Date() };
          if (renamed) set.name = this.checkedName(patch.name as string);
          if (accessPatch !== undefined) set.secretsAccess = accessPatch;
          if (patch.isDefault !== undefined) {
            if (patch.isDefault) {
              await tx
                .update(environments)
                .set({ isDefault: false, updatedAt: new Date() })
                .where(and(eq(environments.organizationId, env.organizationId), eq(environments.isDefault, true)));
              set.isDefault = true;
            } else {
              set.isDefault = false;
            }
          }
          const [next] = await tx
            .update(environments)
            .set(set)
            .where(eq(environments.id, env.id))
            .returning();
          row = next;
          if (renamed) await this.renameDockRefs(tx, env.organizationId, env.name, next.name);
        }
        if (posture) await this.bumpVersion(tx, row, (draft) => ({ ...draft, ...posture }));
        return row;
      });
      return this.viewOf(updated);
    } catch (err) {
      if (isUniqueViolation(err)) throw new EnvironmentNameTakenException();
      throw err;
    }
  }

  /** Soft delete; the default passes to the oldest sibling, the last one stays. */
  async remove(callerId: string, ref: string, organizationId?: string): Promise<{ deleted: boolean }> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    const siblings = await this.liveEnvironments(env.organizationId);
    if (siblings.length <= 1) throw validationError('The default environment cannot be deleted while it is the only one');
    await this.db.transaction(async (tx) => {
      await tx
        .update(environments)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(environments.id, env.id));
      if (env.isDefault) {
        const next = siblings.filter((s) => s.id !== env.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        await tx
          .update(environments)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(environments.id, next.id));
      }
    });
    return { deleted: true };
  }

  async listVersions(callerId: string, ref: string, organizationId?: string): Promise<EnvironmentVersionView[]> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'member');
    const rows = await this.db
      .select()
      .from(environmentVersions)
      .where(eq(environmentVersions.environmentId, env.id))
      .orderBy(desc(environmentVersions.version));
    const counts = await this.dockCounts(env.organizationId, env.name);
    return rows.map((row) => ({ version: row.version, createdAt: row.createdAt, dockCount: counts[row.version] ?? 0 }));
  }

  /** Moves pins to the latest version; callers apply moved docks to their disks. */
  async upgrade(
    callerId: string,
    ref: string,
    organizationId: string | undefined,
    dockIds?: string[],
  ): Promise<{ operation: OperationView; moved: string[]; orgId: string }> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    const latest = await this.latestVersion(env.id);
    const pin = `v${latest.version}`;
    const wsRows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organizationId, env.organizationId));
    const wsIds = wsRows.map((w) => w.id);
    let targets: { id: string; envVersionPin: string | null }[] = [];
    if (dockIds?.length) {
      for (const id of dockIds) {
        if (!UUID_RE.test(id)) throw new DockNotFoundException();
        const [dock] = await this.db.select().from(docks).where(eq(docks.id, id)).limit(1);
        if (!dock || !wsIds.includes(dock.workspaceId) || dock.environment !== env.name) throw new DockNotFoundException();
        targets.push(dock);
      }
    } else if (wsIds.length) {
      targets = await this.db
        .select({ id: docks.id, envVersionPin: docks.envVersionPin })
        .from(docks)
        .where(and(inArray(docks.workspaceId, wsIds), eq(docks.environment, env.name)));
    }
    const op = await this.ops.create(env.organizationId, 'environment', env.id);
    const moved: string[] = [];
    for (const dock of targets) {
      if (!this.isOlderPin(dock.envVersionPin, latest.version)) continue;
      moved.push(dock.id);
      await this.db
        .update(docks)
        .set({ envVersionPin: pin, updatedAt: new Date() })
        .where(eq(docks.id, dock.id));
    }
    return { operation: await this.ops.complete(op.id), moved, orgId: env.organizationId };
  }

  async listRepos(callerId: string, ref: string, organizationId?: string): Promise<EnvironmentView['repos']> {
    return (await this.getByRef(callerId, ref, organizationId)).repos;
  }

  async addRepo(callerId: string, ref: string, organizationId: string | undefined, input: AddRepoInput): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    if (!(ENV_PROVIDERS as readonly string[]).includes(input.provider)) {
      throw validationError('provider must be github or gitlab');
    }
    const repositoryId = input.repositoryId?.trim() ?? '';
    if (!repositoryId || repositoryId.length > MAX_BRANCH_LENGTH) {
      throw validationError('repositoryId must be 1-128 chars');
    }
    if (!FULL_NAME_RE.test(input.fullName ?? '')) {
      throw validationError('fullName must be owner/name');
    }
    const folder = input.fullName.split('/')[1];
    if (folder === '.' || folder === '..' || folder === '.dock') {
      throw validationError('fullName must name a cloneable repository');
    }
    const baseBranch = input.baseBranch?.trim() || null;
    if (baseBranch && baseBranch.length > MAX_BRANCH_LENGTH) {
      throw validationError('baseBranch must be at most 128 chars');
    }
    if (input.setupScript !== undefined && Buffer.byteLength(input.setupScript, 'utf8') > MAX_SETUP_SCRIPT_BYTES) {
      throw validationError('setupScript must be at most 64KB');
    }
    await this.bumpChecked(env, (draft) => {
      if (draft.repos.some((r) => r.provider === input.provider && r.repositoryId === repositoryId)) {
        throw new ConflictException({ code: 'conflict', message: 'Repository is already selected' });
      }
      if (draft.repos.some((r) => r.fullName.split('/')[1] === folder)) {
        throw new ConflictException({ code: 'conflict', message: `Another repository already clones into ${folder}` });
      }
      return {
        ...draft,
        repos: [
          ...draft.repos,
          { id: randomUUID(), provider: input.provider, repositoryId, fullName: input.fullName, baseBranch, setupScript: input.setupScript ?? null },
        ],
      };
    });
    return this.viewOf(env);
  }

  async removeRepo(callerId: string, ref: string, organizationId: string | undefined, repoId: string): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    await this.bumpChecked(env, (draft) => {
      if (!draft.repos.some((r) => r.id === repoId)) {
        throw new NotFoundException({ code: 'not_found', message: 'Repository not found' });
      }
      return { ...draft, repos: draft.repos.filter((r) => r.id !== repoId) };
    });
    return this.viewOf(env);
  }

  /** Full replacement: omitted variables and files are dropped. */
  async replaceSecrets(callerId: string, ref: string, organizationId: string | undefined, input: BulkSecretsInput): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    const vars = parseEnvContents(input.envContents ?? '');
    const files = this.checkedFiles(input.secretFiles ?? []);
    const latest = await this.latestVersion(env.id);
    await this.bumpVersion(this.db, env, () => ({
      safeForThirdParties: latest.safeForThirdParties,
      passGithub: latest.passGithub,
      passSecrets: latest.passSecrets,
      passDockCredentials: latest.passDockCredentials,
      passAgentsCredentials: latest.passAgentsCredentials,
      repos: latest.repos,
      envVars: this.sealAll(vars),
      secretFiles: this.sealFiles(files),
    }));
    return this.viewOf(env);
  }

  async setVar(callerId: string, ref: string, organizationId: string | undefined, key: string, value: string): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    assertEnvKey(key.trim());
    if (typeof value !== 'string') throw validationError('secret value must be a string');
    await this.bumpChecked(env, (draft) => {
      const vars = { ...this.openAll(draft.envVars), [key.trim()]: value };
      assertEnvMap(vars);
      return { ...draft, envVars: this.sealAll(vars) };
    });
    return this.viewOf(env);
  }

  async removeVar(callerId: string, ref: string, organizationId: string | undefined, key: string): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    await this.bumpChecked(env, (draft) => {
      const vars = this.openAll(draft.envVars);
      if (!(key in vars)) throw new NotFoundException({ code: 'not_found', message: 'Variable not found' });
      const rest = Object.fromEntries(Object.entries(vars).filter(([k]) => k !== key));
      return { ...draft, envVars: this.sealAll(rest) };
    });
    return this.viewOf(env);
  }

  async setFile(callerId: string, ref: string, organizationId: string | undefined, path: string, contents: string): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    assertSecretPath(path);
    if (typeof contents !== 'string') throw validationError('secret file contents must be a string');
    await this.bumpChecked(env, (draft) => {
      const files = this.openFiles(draft.secretFiles).filter((f) => f.path !== path);
      return { ...draft, secretFiles: this.sealFiles(this.checkedFiles([...files, { path, contents }])) };
    });
    return this.viewOf(env);
  }
  async removeFile(callerId: string, ref: string, organizationId: string | undefined, path: string): Promise<EnvironmentView> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    await this.bumpChecked(env, (draft) => {
      if (!draft.secretFiles.some((f) => f.path === path)) {
        throw new NotFoundException({ code: 'not_found', message: 'Secret file not found' });
      }
      return { ...draft, secretFiles: draft.secretFiles.filter((f) => f.path !== path) };
    });
    return this.viewOf(env);
  }

  /** Single plaintext path; every other read stays masked. */
  async revealSecrets(callerId: string, ref: string, organizationId?: string): Promise<RevealedSecrets> {
    const env = await this.resolveRef(callerId, ref, organizationId, 'admin');
    const version = await this.latestVersion(env.id);
    return {
      envContents: serializeEnvContents(this.openAll(version.envVars)),
      secretFiles: this.openFiles(version.secretFiles),
    };
  }

  /** Cheap pin validation for dock start; omitted name is the org default. No decryption, no membership check. */
  async resolveVersion(organizationId: string, name?: string): Promise<{ environment: Environment; version: EnvironmentVersion }> {
    const [env] = await this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.organizationId, organizationId),
          name === undefined ? eq(environments.isDefault, true) : eq(environments.name, name),
          isNull(environments.deletedAt),
        ),
      )
      .limit(1);
    if (!env) throw new EnvironmentNotFoundException();
    return { environment: env, version: await this.latestVersion(env.id) };
  }

  /**
   * Refuses a member reading a dock they did not create when its recorded
   * environment and pin delivered admins-only secrets; its creator could only
   * have launched it if allowed. Derived from the env rather than stored.
   */
  async assertDockSecretsReadable(
    callerId: string,
    organizationId: string,
    dock: { createdBy: string | null; environment: string; envVersionPin: string | null; noEnv: boolean; createdAt: Date; envBoundAt?: Date | null },
  ): Promise<void> {
    if (dock.createdBy === callerId) return;
    await this.assertSecretsLaunchable(callerId, organizationId, dock.environment, {
      pin: dock.envVersionPin,
      noEnv: dock.noEnv,
      creatorId: dock.createdBy,
      dockBoundAt: dock.envBoundAt ?? dock.createdAt,
    });
  }

  /**
   * Refuses a member a dock that would receive an admins-only environment's secrets, files, agent keys or dock key.
   * With dockBoundAt (the read path, when the dock was last pointed at its environment) the disk already holds the bundle, so a missing environment, or one
   * re-created after the dock, refuses members instead of passing.
   */
  async assertSecretsLaunchable(
    callerId: string,
    organizationId: string,
    name: string | undefined,
    opts: { pin?: string | null; noEnv?: boolean; dockBoundAt?: Date; creatorId?: string | null } = {},
  ): Promise<void> {
    if (opts.noEnv) return;
    const dockBoundAt = opts.dockBoundAt;
    let resolved: { environment: Environment; version: EnvironmentVersion };
    try {
      resolved = await this.resolveVersion(organizationId, name);
    } catch (err) {
      if (!(err instanceof EnvironmentNotFoundException)) throw err;
      if (dockBoundAt) await this.refuseMembers(organizationId, callerId);
      return;
    }
    // A same-name environment created after the dock says nothing about what the dock's disk holds.
    if (dockBoundAt && resolved.environment.createdAt > dockBoundAt) {
      await this.refuseMembers(organizationId, callerId);
      return;
    }
    if (resolved.environment.secretsAccess !== 'admins') return;
    const membership = await this.orgs.requireMembership(organizationId, callerId);
    if (membership.role !== 'member') return;
    const match = opts.pin ? VERSION_PIN_RE.exec(opts.pin) : null;
    const pinned = match ? await this.versionAt(resolved.environment.id, Number(match[1])) : resolved.version;
    if (pinned.safeForThirdParties) return;
    const injectsSecrets = pinned.passSecrets && (Object.keys(pinned.envVars).length > 0 || pinned.secretFiles.length > 0);
    if (injectsSecrets || pinned.passDockCredentials) throw new EnvironmentSecretsAdminOnlyException();
    // Mirrors what the apply step injects: org provider keys for the default agents, or the creator's ChatGPT sign-in.
    if (pinned.passAgentsCredentials && (await this.agentCredentialsPresent(organizationId, callerId, opts.creatorId === undefined ? callerId : opts.creatorId))) {
      throw new EnvironmentSecretsAdminOnlyException();
    }
  }

  private async agentCredentialsPresent(organizationId: string, callerId: string, creatorId: string | null): Promise<boolean> {
    const { providers } = await this.creds.varsFor(organizationId, requiredKeysFor(DEFAULT_DOCK_AGENTS));
    if (providers.length) return true;
    const chatgptAgents = DEFAULT_DOCK_AGENTS.filter((a) => (CHATGPT_DOCK_AGENTS as readonly string[]).includes(a));
    // The caller's own sign-in is theirs to read; only another user's counts.
    if (!chatgptAgents.length || !creatorId || creatorId === callerId) return false;
    // Fail closed for members if the sign-in lookup is not wired.
    if (!this.chatgpt) return true;
    return this.chatgpt.usable(creatorId);
  }

  private async refuseMembers(organizationId: string, callerId: string): Promise<void> {
    const membership = await this.orgs.requireMembership(organizationId, callerId);
    if (membership.role === 'member') throw new EnvironmentSecretsAdminOnlyException();
  }

  /** Full driver bundle at a pinned version; safe/noEnv withholds everything. */
  async resolveBundle(
    organizationId: string,
    name: string | undefined,
    opts: { version?: number; perDockEnv?: Record<string, string>; noEnv?: boolean; agents?: string[] } = {},
  ): Promise<ResolvedBundle> {
    const { version } = await this.resolveVersion(organizationId, name);
    const pinned =
      opts.version === undefined
        ? version
        : await this.versionAt(version.environmentId, opts.version);
    const safe = pinned.safeForThirdParties || opts.noEnv === true;
    const stored = safe || !pinned.passSecrets ? {} : this.openAll(pinned.envVars);
    // Platform keys fill only vars the user did not set; user-supplied
    // tokens (e.g. ANTHROPIC_AUTH_TOKEN) are never deleted or overridden.
    const wanted = requiredKeysFor(opts.agents ?? []);
    const injected =
      safe || !pinned.passAgentsCredentials || !wanted.length
        ? { vars: {}, providers: [] as ProviderName[] }
        : await this.creds.varsFor(organizationId, wanted);
    if (opts.perDockEnv) for (const key of Object.keys(opts.perDockEnv)) assertNotReserved(key);
    return {
      version: pinned.version,
      vars: { ...injected.vars, ...stored, ...(opts.perDockEnv ?? {}) },
      files: safe || !pinned.passSecrets ? [] : this.openFiles(pinned.secretFiles),
      repos: safe || !pinned.passGithub ? [] : pinned.repos,
      injectedProviders: injected.providers,
      passDockCredentials: !safe && pinned.passDockCredentials,
      passAgentsCredentials: !safe && pinned.passAgentsCredentials,
    };
  }

  private async resolveRef(callerId: string, ref: string, organizationId: string | undefined, minRole: 'member' | 'admin'): Promise<Environment> {
    let env: Environment | null = null;
    if (UUID_RE.test(ref)) {
      const [row] = await this.db.select().from(environments).where(eq(environments.id, ref)).limit(1);
      env = row ?? null;
    }
    if (!env) {
      if (!organizationId) throw new EnvironmentNotFoundException();
      if (!UUID_RE.test(organizationId)) throw validationError('organizationId must be a UUID');
      const [row] = await this.db
        .select()
        .from(environments)
        .where(and(eq(environments.organizationId, organizationId), eq(environments.name, ref), isNull(environments.deletedAt)))
        .limit(1);
      env = row ?? null;
    }
    if (!env || env.deletedAt) throw new EnvironmentNotFoundException();
    try {
      await this.orgs.requireMembership(env.organizationId, callerId, minRole);
    } catch (err) {
      if (err instanceof OrganizationNotFoundException) throw new EnvironmentNotFoundException();
      throw err;
    }
    return env;
  }

  /** Docks reference environments by name, so a rename carries them along. */
  private async renameDockRefs(tx: OrgTx, orgId: string, from: string, to: string): Promise<void> {
    const wsRows = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.organizationId, orgId));
    if (!wsRows.length) return;
    await tx
      .update(docks)
      .set({ environment: to, updatedAt: new Date() })
      .where(and(inArray(docks.workspaceId, wsRows.map((w) => w.id)), eq(docks.environment, from)));
  }

  private async liveEnvironments(orgId: string): Promise<Environment[]> {
    return this.db
      .select()
      .from(environments)
      .where(and(eq(environments.organizationId, orgId), isNull(environments.deletedAt)))
      .orderBy(desc(environments.createdAt));
  }

  /** Lazy base for orgs predating this change; unique constraint decides races. */
  private async ensureBase(orgId: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [env] = await tx
          .insert(environments)
          .values({ organizationId: orgId, name: 'base', isDefault: true })
          .returning();
        await tx
          .insert(environmentVersions)
          .values({ environmentId: env.id, version: 1, repos: [], envVars: {}, secretFiles: [] });
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  private async latestVersion(environmentId: string): Promise<EnvironmentVersion> {
    const [row] = await this.db
      .select()
      .from(environmentVersions)
      .where(eq(environmentVersions.environmentId, environmentId))
      .orderBy(desc(environmentVersions.version))
      .limit(1);
    if (!row) throw new EnvironmentNotFoundException();
    return row;
  }

  private async versionAt(environmentId: string, version: number): Promise<EnvironmentVersion> {
    const [row] = await this.db
      .select()
      .from(environmentVersions)
      .where(and(eq(environmentVersions.environmentId, environmentId), eq(environmentVersions.version, version)))
      .limit(1);
    if (!row) throw new EnvironmentNotFoundException();
    return row;
  }

  /** Content save: copies latest, applies the change, mints the next version. */
  private async bumpVersion(executor: OrgTx, env: Environment, mutate: (draft: VersionContent) => VersionContent): Promise<EnvironmentVersion> {
    const [current] = await executor
      .select()
      .from(environmentVersions)
      .where(and(eq(environmentVersions.environmentId, env.id), eq(environmentVersions.version, env.currentVersion)))
      .limit(1);
    if (!current) throw new EnvironmentNotFoundException();
    const draft = mutate({
      safeForThirdParties: current.safeForThirdParties,
      passGithub: current.passGithub,
      passSecrets: current.passSecrets,
      passDockCredentials: current.passDockCredentials,
      passAgentsCredentials: current.passAgentsCredentials,
      repos: current.repos.map((r) => ({ ...r })),
      envVars: { ...current.envVars },
      secretFiles: current.secretFiles.map((f) => ({ ...f })),
    });
    const next = env.currentVersion + 1;
    try {
      const [row] = await executor
        .insert(environmentVersions)
        .values({ environmentId: env.id, version: next, ...draft })
        .returning();
      await executor
        .update(environments)
        .set({ currentVersion: next, updatedAt: new Date() })
        .where(eq(environments.id, env.id));
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException({ code: 'conflict', message: 'Environment changed, retry' });
      throw err;
    }
  }

  /** Bump inside its own transaction for single-save callers. */
  private async bumpChecked(env: Environment, mutate: (draft: VersionContent) => VersionContent): Promise<void> {
    await this.db.transaction(async (tx) => this.bumpVersion(tx, env, mutate));
  }

  private checkedName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!ENV_NAME_RE.test(name)) {
      throw validationError('Name must be 2-64 lowercase letters, digits, dash, or underscore');
    }
    return name;
  }

  private checkedPosture(patch: UpdateEnvironmentInput): Partial<VersionContent> | null {
    const out: Partial<VersionContent> = {};
    for (const key of ['safeForThirdParties', 'passGithub', 'passSecrets', 'passDockCredentials', 'passAgentsCredentials'] as const) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') throw validationError(`${key} must be a boolean`);
        out[key] = patch[key] as boolean;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  private checkedFiles(files: { path: string; contents: string }[]): { path: string; contents: string }[] {
    if (files.length > MAX_SECRET_FILES) throw validationError('at most 20 secret files');
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
      assertSecretPath(file.path);
      if (typeof file.contents !== 'string') throw validationError('secret file contents must be a string');
      if (seen.has(file.path)) throw validationError(`secret file ${file.path} is duplicated`);
      seen.add(file.path);
      const size = Buffer.byteLength(file.contents, 'utf8');
      if (size > MAX_SECRET_FILE_BYTES) throw validationError(`secret file ${file.path} exceeds 256KB`);
      total += size;
    }
    if (total > MAX_SECRET_FILES_BYTES) throw validationError('secret files total at most 1MB');
    return files;
  }

  private sealAll(vars: Record<string, string>): Record<string, SealedValue> {
    return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, sealValue(this.key, v)]));
  }

  private openAll(vars: Record<string, SealedValue>): Record<string, string> {
    return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, openValue(this.key, v)]));
  }

  private sealFiles(files: { path: string; contents: string }[]): EnvSecretFile[] {
    return files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.contents, 'utf8'), contents: sealValue(this.key, f.contents) }));
  }

  private openFiles(files: EnvSecretFile[]): { path: string; size: number; contents: string }[] {
    return files.map((f) => ({ path: f.path, size: f.size, contents: openValue(this.key, f.contents) }));
  }

  private isOlderPin(pin: string | null, latest: number): boolean {
    if (!pin) return true;
    const match = VERSION_PIN_RE.exec(pin);
    if (!match) return true;
    return Number(match[1]) < latest;
  }

  private async dockCounts(organizationId: string, envName: string): Promise<Record<number, number>> {
    const wsRows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organizationId, organizationId));
    if (!wsRows.length) return {};
    const dockRows = await this.db
      .select({ pin: docks.envVersionPin })
      .from(docks)
      .where(and(inArray(docks.workspaceId, wsRows.map((w) => w.id)), eq(docks.environment, envName)));
    const counts: Record<number, number> = {};
    for (const row of dockRows) {
      const match = row.pin ? VERSION_PIN_RE.exec(row.pin) : null;
      if (!match) continue;
      const version = Number(match[1]);
      counts[version] = (counts[version] ?? 0) + 1;
    }
    return counts;
  }

  /** Connected means docks can clone private repos: a GitHub App installation in the org. GitLab has no integration yet. */
  private async connectionStatus(organizationId: string): Promise<Record<EnvProvider, ConnectionView>> {
    const status: Record<EnvProvider, ConnectionView> = { github: { connected: false }, gitlab: { connected: false } };
    const wsRows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organizationId, organizationId));
    if (!wsRows.length || !this.githubAppConfigured) return status;
    const installations = await this.db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(inArray(githubInstallations.workspaceId, wsRows.map((w) => w.id)));
    status.github = { connected: installations.length > 0 };
    return status;
  }

  private toView(env: Environment, version: EnvironmentVersion, connections: Record<EnvProvider, ConnectionView>): EnvironmentView {
    return {
      id: env.id,
      organizationId: env.organizationId,
      name: env.name,
      isDefault: env.isDefault,
      currentVersion: env.currentVersion,
      secretsAccess: env.secretsAccess,
      safeForThirdParties: version.safeForThirdParties,
      passGithub: version.passGithub,
      passSecrets: version.passSecrets,
      passDockCredentials: version.passDockCredentials,
      passAgentsCredentials: version.passAgentsCredentials,
      connections,
      varNames: Object.keys(version.envVars).sort(),
      files: version.secretFiles.map((f) => ({ path: f.path, size: f.size })),
      repos: version.repos.map((r) => ({
        id: r.id,
        provider: r.provider,
        repositoryId: r.repositoryId,
        fullName: r.fullName,
        baseBranch: r.baseBranch,
        hasSetupScript: r.setupScript !== null,
      })),
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
    };
  }

  private async viewOf(env: Environment): Promise<EnvironmentView> {
    const [row] = await this.db.select().from(environments).where(eq(environments.id, env.id)).limit(1);
    if (!row || row.deletedAt) throw new EnvironmentNotFoundException();
    return this.toView(row, await this.latestVersion(row.id), await this.connectionStatus(row.organizationId));
  }
}
