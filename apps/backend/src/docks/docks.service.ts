import {
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { hashToken, newUuid } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import {
  DEFAULT_CPUS,
  DEFAULT_DISK_GIB,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY_MIB,
  DOCK_IMAGES,
  docks,
  idempotencyKeys,
  organizationMembers,
  snapshots,
  templates,
  workspaces,
  type Dock,
  type DockState,
  type Runtime,
  type Template,
  type WebhookEventType,
} from '../database/schema';
import { scopeOrgIds } from '../auth/dock-scope';
import {
  OrganizationNotFoundException,
  OrganizationsService,
  isUniqueViolation,
} from '../organizations/organizations.service';
import { RetentionService } from '../retention/retention.service';
import { deleteGenerations, orphanedGenerations } from '../retention/generation-cleanup';
import { OperationsService, type OperationView } from '../retention/operations.service';
import { WorkspaceNotFoundException, WorkspacesService } from '../workspaces/workspaces.service';
import { assertNotReserved } from '../environments/env-validation';
import { EnvironmentNotFoundException, EnvironmentSecretsAdminOnlyException, EnvironmentsService } from '../environments/environments.service';
import { ConnectorAdminOnlyException, ConnectorsService } from '../connectors/connectors.service';
import { EnvironmentApplyService } from '../environments/environment-apply.service';
import { ConfirmRequiredException, DockDeleteForbiddenException, DockNotFoundException, NoHostCapacityException, SnapshotInUseException, TEMPLATE_RE, TemplateSourceMissingException, TemplateNotFoundException, CapacityExhaustedException, DockNameTakenException, ImageUnavailableException, HostEgressUnsupportedException } from './dock-errors';
import { EGRESS_ON_RESUME } from '../hosts/host-features';
import { COMPUTE_PROVIDER, ComputeProvider } from './compute.provider';
import { DockletException } from '../runtime/docklet.client';
import { MeteringService } from '../metering/metering.service';
import { SpendGate } from '../metering/spend-gate';
import { BaseImageUnavailableException, HostsService } from '../hosts/hosts.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Host } from '../database/schema';

/** Recovery waits for an orphaned capture this long: 60 tries every 5s. */
export const RECOVERY_CAPTURE_ATTEMPTS = 60;
export const RECOVERY_CAPTURE_RETRY_MS = 5000;

/** Per-dock size; ranges are checked here, upper bounds by host capacity at placement. */
export interface DockSizeInput {
  cpus?: number;
  memoryMiB?: number;
  diskGiB?: number;
}

export interface CreateDockInput extends DockSizeInput {
  workspaceId: string;
  name?: string;
  image?: string;
  ttlSeconds?: number | null;
  env?: Record<string, string>;
  environment?: string;
  noEnv?: boolean;
  from?: string;
  setupScript?: string;
  /** Connector kinds to wire into the dock; each must be connected in the workspace. */
  connectors?: string[];
  /** Internal only: confines the dock to these HTTPS hosts (GitHub runs). */
  egressAllow?: string[];
}

export interface UpdateDockInput extends DockSizeInput {
  name?: string;
  ttlSeconds?: number | null;
}

export interface StopDockInput {
  force?: boolean;
}

export interface ResumeDockInput extends DockSizeInput {
  ttlSeconds?: number | null;
  environment?: string;
  noEnv?: boolean;
}

export interface BranchDockInput extends DockSizeInput {
  name?: string;
  image?: string;
  ttlSeconds?: number | null;
  env?: Record<string, string>;
  environment?: string;
  noEnv?: boolean;
}
const MAX_ENV_KEYS = 100;
const MAX_ENV_BYTES = 65536;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a boot restores from, constraining which hosts can run it. */
type PlacementSource = { cpuFamily: string | null | undefined; runtime?: Runtime | null; baseFingerprint?: string | null; feature?: string };

type DockSize = { cpus: number; memoryMiB: number; diskGiB: number };

/** How often docks past their ttlSeconds are stopped. */
const TTL_SWEEP_MS = 60_000;
/** Docks stopped per sweep tick. */
const TTL_SWEEP_BATCH = 50;
export const RUNNABLE_STATES: DockState[] = ['provisioning', 'provisioned', 'cloning', 'ready', 'idle', 'running', 'error', 'unreachable'];
const FILTER_GROUPS: Record<string, DockState[]> = {
  r: ['ready', 'cloning', 'idle', 'running'],
  s: ['archived'],
  p: ['provisioning', 'provisioned'],
  t: ['archiving'],
  e: ['error', 'unreachable'],
};

export class IdempotencyInProgressException extends ConflictException {
  constructor() {
    super({ code: 'idempotency_in_progress', message: 'Creation already in progress for this key' });
  }
}

export class IdempotencyKeyReusedException extends ConflictException {
  constructor() {
    super({ code: 'idempotency_key_reused', message: 'Idempotency key already used with a different body' });
  }
}

export class DockConflictException extends ConflictException {
  constructor(message: string) {
    super({ code: 'conflict', message });
  }
}

export class StopRefusedException extends ServiceUnavailableException {
  constructor() {
    super({ code: 'service_unavailable', message: 'Final snapshot failed; dock left running, billing paused' });
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

function checkedInt(name: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw validationError(`${name} must be an integer of at least ${min}`);
  return value;
}

/** Applies defaults and range checks to a requested size; `base` supplies the inherited values. */
export function checkedSize(input: DockSizeInput, base: DockSize = { cpus: DEFAULT_CPUS, memoryMiB: DEFAULT_MEMORY_MIB, diskGiB: DEFAULT_DISK_GIB }): DockSize {
  return {
    cpus: input.cpus === undefined ? base.cpus : checkedInt('cpus', input.cpus, 1),
    memoryMiB: input.memoryMiB === undefined ? base.memoryMiB : checkedInt('memoryMiB', input.memoryMiB, 512),
    diskGiB: input.diskGiB === undefined ? base.diskGiB : checkedInt('diskGiB', input.diskGiB, 1),
  };
}

/** Catalog images only. Availability is not checked here: hosts do not report images yet, so the host refuses one it lacks. */
function checkedImage(image: unknown): string {
  if (image === undefined) return DEFAULT_IMAGE;
  if (typeof image === 'string' && DOCK_IMAGES.includes(image)) return image;
  throw new BadRequestException({ code: 'image_unknown', message: `Unknown image. Valid images: ${DOCK_IMAGES.join(', ')}` });
}

function checkedName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 100) throw validationError('Name must be 1-100 characters');
  return trimmed;
}

/** Placement said no (no host, no room, no base, size over every host); nothing was started. */
function isPlacementRefusal(err: unknown): boolean {
  return err instanceof NoHostCapacityException || err instanceof CapacityExhaustedException || err instanceof BaseImageUnavailableException || err instanceof HostEgressUnsupportedException || err instanceof BadRequestException;
}

/** Narrows docklet concurrency refusals so recovery can wait for adoption. */
function isSnapshotInProgress(err: unknown): err is DockletException {
  return err instanceof DockletException && err.code === 'snapshot_in_progress';
}

/**
 * Dock lifecycle: workspace-scoped state machine over the provider port.
 * Item routes hide foreign existence as 404; deletes are confirmed, async,
 * and unrecoverable.
 */
@Injectable()
export class DocksService {
  private ttlTimer?: NodeJS.Timeout;
  private ttlSweeping = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly workspaces: WorkspacesService,
    private readonly retention: RetentionService,
    private readonly ops: OperationsService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
    private readonly envs: EnvironmentsService,
    private readonly metering: MeteringService,
    private readonly spendGate: SpendGate,
    private readonly hosts: HostsService,
    private readonly config: ConfigService,
    private readonly webhooks: WebhooksService,
    private readonly notifications: NotificationsService,
    private readonly applier: EnvironmentApplyService,
    private readonly connectors: ConnectorsService,
  ) {}

  /** Dock plus owning org, membership-checked. Shared with snapshots/templates. */
  async loadDock(
    callerId: string,
    id: string,
    minRole: 'member' | 'admin' | 'owner' = 'member',
  ): Promise<{ dock: Dock; orgId: string }> {
    if (!UUID_RE.test(id)) throw new DockNotFoundException();
    const [dock] = await this.db.select().from(docks).where(eq(docks.id, id)).limit(1);
    if (!dock) throw new DockNotFoundException();
    const [ws] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, dock.workspaceId))
      .limit(1);
    if (!ws) throw new DockNotFoundException();
    try {
      await this.orgs.requireMembership(ws.organizationId, callerId, minRole);
    } catch (err) {
      if (err instanceof OrganizationNotFoundException) throw new DockNotFoundException();
      throw err;
    }
    return { dock, orgId: ws.organizationId };
  }

  /** loadDock for routes that expose a dock's disk or shell; refuses a member the secrets an admins-only environment delivered into it. */
  async loadReadableDock(callerId: string, id: string): Promise<{ dock: Dock; orgId: string }> {
    const loaded = await this.loadDock(callerId, id);
    await this.envs.assertDockSecretsReadable(callerId, loaded.orgId, loaded.dock);
    // The dock holds a live connector gateway token; only its creator or an admin may reach its shell.
    if (loaded.dock.connectors?.length && loaded.dock.createdBy !== callerId) await this.refuseConnectorMembers(loaded.orgId, callerId);
    return loaded;
  }

  /** Re-applies the dock's bundle, replacing its connector gateway token; reloads the row so a pin moved meanwhile is not reverted. */
  async reapply(dock: Dock, orgId: string): Promise<void> {
    const [fresh] = await this.db.select().from(docks).where(eq(docks.id, dock.id)).limit(1);
    if (fresh) await this.applier.apply(fresh, orgId);
  }

  private async refuseConnectorMembers(orgId: string, callerId: string): Promise<void> {
    if ((await this.orgs.requireMembership(orgId, callerId)).role === 'member') throw new ConnectorAdminOnlyException();
  }

  /** Scheduler placement for restate-mode writes, reserving the dock's cpus and memory; fake mode places nothing. */
  private async placeOrThrow(source: PlacementSource, dock: { id: string } & DockSize, excludeHostIds: string[] = []): Promise<Host | null> {
    if (this.config.get<string>('RUNTIME_DRIVER') !== 'restate') return null;
    const host = await this.hosts.placeForDock({
      cpuFamily: source.cpuFamily ?? undefined,
      runtime: source.runtime ?? null,
      dockId: dock.id,
      cpus: dock.cpus,
      memoryMiB: dock.memoryMiB,
      excludeHostIds,
      ...(source.baseFingerprint ? { baseFingerprint: source.baseFingerprint } : {}),
      ...(source.feature ? { feature: source.feature } : {}),
    });
    if (host) return host;
    // After a docklet refusal the excluded hosts still look placeable, so only a first miss can blame the feature.
    if (!excludeHostIds.length) await this.assertFeatureNotTheCause(source, dock);
    const fit = await this.hosts.sizeFit({ cpus: dock.cpus, memoryMiB: dock.memoryMiB });
    if (fit === 'none_online') throw new NoHostCapacityException();
    if (fit === 'too_large') throw validationError(`Requested size (${dock.cpus} cpus, ${dock.memoryMiB} MiB) exceeds the total capacity of every online host`);
    // Room exists somewhere but the family or runtime rules it out: not a capacity problem.
    if (await this.hosts.anyOnlineWithHeadroom({ cpus: dock.cpus, memoryMiB: dock.memoryMiB, dockId: dock.id, excludeHostIds })) throw new NoHostCapacityException();
    throw new CapacityExhaustedException();
  }

  /** A miss that disappears without the feature requirement means the hosts lack the feature. */
  private async assertFeatureNotTheCause(source: PlacementSource, size: DockSize): Promise<void> {
    if (!source.feature) return;
    const ok = await this.hosts.canPlace({ cpuFamily: source.cpuFamily, runtime: source.runtime ?? null, baseFingerprint: source.baseFingerprint, cpus: size.cpus, memoryMiB: size.memoryMiB });
    if (ok) throw new HostEgressUnsupportedException();
  }

  /** The source dock's recorded family (from its host row) and runtime, for the branch pre-check. */
  private async branchSource(dock: Dock): Promise<PlacementSource> {
    const host = dock.hostId ? await this.hosts.getById(dock.hostId) : null;
    return { cpuFamily: host?.cpuFamily, runtime: dock.runtime };
  }

  /** Advisory pre-insert check so a refused size, family or runtime leaves no row; placeAndRun still decides at provision time. */
  private async assertPlaceable(size: DockSize, source?: PlacementSource): Promise<void> {
    if (this.config.get<string>('RUNTIME_DRIVER') !== 'restate') return;
    const fit = await this.hosts.sizeFit({ cpus: size.cpus, memoryMiB: size.memoryMiB });
    if (fit === 'none_online') throw new NoHostCapacityException();
    if (fit === 'too_large') throw validationError(`Requested size (${size.cpus} cpus, ${size.memoryMiB} MiB) exceeds the total capacity of every online host`);
    if (!(await this.hosts.anyOnlineWithHeadroom({ cpus: size.cpus, memoryMiB: size.memoryMiB }))) throw new CapacityExhaustedException();
    if (!source || (source.cpuFamily == null && source.runtime == null && !source.baseFingerprint && !source.feature)) return;
    // Room exists somewhere, so a miss here is family, runtime or base, as in placeOrThrow.
    const ok = await this.hosts.canPlace({ cpuFamily: source.cpuFamily, runtime: source.runtime ?? null, baseFingerprint: source.baseFingerprint, ...(source.feature ? { feature: source.feature } : {}), cpus: size.cpus, memoryMiB: size.memoryMiB });
    if (!ok) {
      await this.assertFeatureNotTheCause(source, size);
      throw new NoHostCapacityException();
    }

  }

  /**
   * Places then runs the boot. A host whose docklet refuses with capacity_exhausted, or with
   * base_image_unavailable (a generation recorded before bases were tracked), is skipped and
   * placement retried; running out of hosts after a base refusal reports the base, not capacity.
   * A host refusing a Dockyard image it does not serve (image_unavailable) is skipped the same way.
   */
  private async placeAndRun<T>(source: PlacementSource, dock: { id: string; image?: string } & DockSize, run: (host: Host | null) => Promise<T>): Promise<{ machine: T; runtime?: Runtime }> {
    const excluded: string[] = [];
    let baseRefused = false;
    let imageRefused = false;
    for (;;) {
      let host: Host | null;
      try {
        host = await this.placeOrThrow(source, dock, excluded);
      } catch (err) {
        const exhausted = err instanceof NoHostCapacityException || err instanceof CapacityExhaustedException;
        if (imageRefused && exhausted) throw new ImageUnavailableException(dock.image ?? DEFAULT_IMAGE);
        if (baseRefused && exhausted) throw new BaseImageUnavailableException();
        throw err;
      }
      try {
        return { machine: await run(host), runtime: host?.runtime };
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (!host || (code !== 'capacity_exhausted' && code !== 'base_image_unavailable' && code !== 'image_unavailable')) throw err;
        if (code === 'base_image_unavailable') baseRefused = true;
        if (code === 'image_unavailable') imageRefused = true;
        excluded.push(host.id);
      }
    }
  }

  /** Name an operator gave, or a generated one; unique per workspace. */
  private async claimName(workspaceId: string, name: string | undefined, excludeId?: string): Promise<string> {
    if (name === undefined) return `dock-${newUuid().slice(0, 8)}`;
    const checked = checkedName(name);
    const [taken] = await this.db
      .select({ id: docks.id })
      .from(docks)
      .where(and(eq(docks.workspaceId, workspaceId), eq(docks.name, checked), ...(excludeId ? [ne(docks.id, excludeId)] : [])))
      .limit(1);
    if (taken) throw new DockNameTakenException(checked);
    return checked;
  }

  async create(callerId: string, input: CreateDockInput, idempotencyKey?: string): Promise<Dock> {
    const size = checkedSize(input);
    const image = checkedImage(input.image);
    const ttlSeconds = input.ttlSeconds === undefined ? null : input.ttlSeconds;
    if (ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2592000)) {
      throw validationError('ttlSeconds must be an integer 60..2592000 or null');
    }
    const env = this.checkedEnv(input.env ?? {});
    if (input.setupScript !== undefined && input.setupScript.length > 65536) {
      throw validationError('setupScript must be at most 64KB');
    }
    const ws = await this.workspaces.getById(callerId, input.workspaceId).catch((err) => {
      if (err instanceof WorkspaceNotFoundException) throw new DockNotFoundException();
      throw err;
    });
    const orgId = ws.organizationId;
    const { environment: envRow, version } = await this.envs.resolveVersion(orgId, input.environment);
    const environment = envRow.name;
    // Internal run docks are egress-confined and receive no bundle, so there is nothing to guard.
    if (!input.egressAllow?.length) {
      await this.envs.assertSecretsLaunchable(callerId, orgId, environment, { pin: `v${version.version}`, noEnv: input.noEnv });
    }
    const noEnv = input.noEnv ?? false;
    // A run's own list wins; otherwise the environment's list applies, even with noEnv.
    const egressAllow = input.egressAllow?.length ? input.egressAllow : (version.egressAllow ?? undefined);
    // Only an environment list needs the host to confine on resume; a run's list predates the feature.
    const placeFeature = !input.egressAllow?.length && egressAllow?.length ? { feature: EGRESS_ON_RESUME } : {};
    let fromTemplate: string | undefined;
    let templateStoreId: string | null | undefined;
    let templateCpuFamily: string | null = null;
    let templateBase: string | null = null;
    let templateRuntime: Runtime | null = null;
    if (input.from !== undefined) {
      const resolved = await this.resolveTemplate(orgId, input.from);
      fromTemplate = resolved.name;
      // The disk may hold the source dock's connector gateway token, so it needs the role a connector dock needs.
      if (resolved.hadConnectors) await this.refuseConnectorMembers(orgId, callerId);
      // The template's disk carries the bundle of the dock it was saved from.
      if (resolved.sourceDockId) {
        const [sourceDock] = await this.db.select().from(docks).where(eq(docks.id, resolved.sourceDockId)).limit(1);
        if (sourceDock) await this.envs.assertDockSecretsReadable(callerId, orgId, sourceDock);
        // A deleted source leaves its disk in the template with nothing to judge it by: admins only.
        else if ((await this.orgs.requireMembership(orgId, callerId)).role === 'member') throw new EnvironmentSecretsAdminOnlyException();
      }
      const source = await this.templateSource(resolved);
      templateStoreId = source.storeId;
      templateCpuFamily = source.cpuFamily;
      templateBase = source.baseFingerprint;
      // A template's disk restores only onto the runtime that captured it.
      templateRuntime = source.runtime;
    }
    const connectorKinds = input.connectors?.length ? await this.connectors.assertConnected(input.workspaceId, input.connectors) : [];
    if (connectorKinds.length) await this.refuseConnectorMembers(orgId, callerId);
    await this.spendGate.requireSpend(orgId);
    if (idempotencyKey) {
      const existing = await this.claimKey(orgId, idempotencyKey, input);
      if (existing) return existing;
    }
    // After the key replay, so a retry of a named create returns its dock instead of 409.
    const [dock] = await this.withKeyReleased(orgId, idempotencyKey, async () => {
      await this.assertPlaceable(size, { cpuFamily: templateCpuFamily, runtime: templateRuntime, baseFingerprint: templateBase, ...placeFeature });
      return this.insertDock({
        workspaceId: input.workspaceId,
        name: await this.claimName(input.workspaceId, input.name),
        ...size,
        image,
        state: 'provisioning',
        ttlSeconds,
        environment,
        envVersionPin: `v${version.version}`,
        noEnv,
        envBoundAt: new Date(),
        env,
        connectors: connectorKinds,
        fromTemplate,
        createdBy: callerId,
        setupStatus: input.egressAllow?.length ? 'done' : 'pending',
      });
    });
    try {
      const { machine, runtime } = await this.placeAndRun({ cpuFamily: templateCpuFamily, runtime: templateRuntime, baseFingerprint: templateBase, ...placeFeature }, dock, (host) =>
        this.provider.provision(dock, {
          snapshotId: templateStoreId ?? null,
          hostId: host?.id ?? null,
          ...(egressAllow?.length ? { egressAllow } : {}),
        }),
      );
      const ready = await this.transition(dock.id, ['provisioning'], { state: 'ready', liveSince: new Date(), ip: machine.ip, hostId: machine.hostId ?? null, runtime: runtime ?? dock.runtime });
      await this.bindKey(orgId, idempotencyKey, ready.id);
      await this.metering.openWindow({ organizationId: orgId, workspaceId: input.workspaceId, dockId: ready.id, ...size });
      // Internal run docks are egress-confined and clone through their own runner.
      const applied = input.egressAllow?.length ? ready : await this.applier.apply(ready, orgId, { setupScript: input.setupScript });
      await this.emitDockEvent('dock.ready', ready.id, input.workspaceId, orgId, 'ready');
      return applied;
    } catch (err) {
      await this.db.update(docks).set({ state: 'error', stateChangedAt: new Date(), updatedAt: new Date() }).where(eq(docks.id, dock.id));
      await this.emitDockEvent('dock.error', dock.id, input.workspaceId, orgId, 'error');
      throw err;
    }
  }

  async list(callerId: string, filter = 'r', all = false): Promise<Dock[]> {
    const states = this.parseFilter(filter, all);
    const orgIds = await this.orgIdsFor(callerId);
    if (!orgIds.length) return [];
    const wsRows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.organizationId, orgIds));
    const wsIds = wsRows.map((w) => w.id);
    if (!wsIds.length) return [];
    const conditions = [inArray(docks.workspaceId, wsIds)];
    if (states) conditions.push(inArray(docks.state, states));
    return this.db.select().from(docks).where(and(...conditions));
  }

  async getById(callerId: string, id: string): Promise<Dock> {
    return (await this.loadDock(callerId, id)).dock;
  }

  async update(callerId: string, id: string, patch: UpdateDockInput): Promise<Dock> {
    const { dock } = await this.loadDock(callerId, id);
    const set: Partial<typeof docks.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      set.name = await this.claimName(dock.workspaceId, patch.name, dock.id);
    }
    if (patch.cpus !== undefined || patch.memoryMiB !== undefined || patch.diskGiB !== undefined) {
      const size = checkedSize(patch, dock);
      // A live machine keeps its size, and placement budgets hosts by the row: resize only while stopped.
      if (dock.state !== 'archived') throw new DockConflictException('Stop the dock to change its size; resume applies it');
      this.requireCapacity(size.diskGiB, dock.diskBytes);
      Object.assign(set, size);
    }
    if (patch.ttlSeconds !== undefined) {
      if (patch.ttlSeconds !== null && (!Number.isInteger(patch.ttlSeconds) || patch.ttlSeconds < 60 || patch.ttlSeconds > 2592000)) {
        throw validationError('ttlSeconds must be an integer 60..2592000 or null');
      }
      set.ttlSeconds = patch.ttlSeconds;
    }
    try {
      const [updated] = await this.db.update(docks).set(set).where(eq(docks.id, id)).returning();
      return updated;
    } catch (err) {
      if (isUniqueViolation(err) && set.name) throw new DockNameTakenException(set.name);
      throw err;
    }
  }

  /** Compare-and-set on state: null when another transition moved the row first. */
  private async tryTransition(id: string, from: DockState[], set: Partial<typeof docks.$inferInsert>): Promise<Dock | null> {
    const now = new Date();
    const [row] = await this.db
      .update(docks)
      .set({ ...set, stateChangedAt: now, updatedAt: now })
      .where(and(eq(docks.id, id), inArray(docks.state, from)))
      .returning();
    return row ?? null;
  }

  /** Compare-only guard: matches the row by state without changing it. */
  private async touchIfState(id: string, state: DockState): Promise<void> {
    const rows = await this.db
      .update(docks)
      .set({ updatedAt: new Date() })
      .where(and(eq(docks.id, id), eq(docks.state, state)))
      .returning({ id: docks.id });
    if (!rows.length) throw new DockConflictException('Dock state changed concurrently');
  }

  private async transition(id: string, from: DockState[], set: Partial<typeof docks.$inferInsert>): Promise<Dock> {
    const row = await this.tryTransition(id, from, set);
    if (!row) throw new DockConflictException('Dock state changed concurrently');
    return row;
  }

  async stop(callerId: string, id: string, opts: StopDockInput = {}): Promise<{ id: string; state: DockState }> {
    const { dock, orgId } = await this.loadDock(callerId, id);
    return this.stopDock(dock, orgId, callerId, opts);
  }

  /**
   * Stops docks whose explicit ttlSeconds elapsed since they last became live.
   * Skips ZDR orgs (a stop deletes data) and docks with a refused stop (billingPausedAt).
   * The stop notification has no reason field, so a TTL stop is not distinguished.
   */
  async sweepExpiredTtl(): Promise<string[]> {
    if (this.ttlSweeping) return [];
    this.ttlSweeping = true;
    try {
      const expired = await this.db
        .select()
        .from(docks)
        .where(
          and(
            inArray(docks.state, ['ready', 'idle', 'running']),
            isNull(docks.billingPausedAt),
            sql`${docks.ttlSeconds} IS NOT NULL AND ${docks.stateChangedAt} + make_interval(secs => ${docks.ttlSeconds}) <= now()`,
          ),
        )
        .orderBy(docks.stateChangedAt)
        .limit(TTL_SWEEP_BATCH);
      const stopped: string[] = [];
      for (const dock of expired) {
        try {
          const orgId = await this.orgForWorkspace(dock.workspaceId);
          if (!orgId || (await this.retention.policyOn(this.db, orgId))) continue;
          await this.stopDock(dock, orgId, null);
          stopped.push(dock.id);
        } catch (err) {
          new Logger('DocksService').warn(`TTL stop of ${dock.id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      return stopped;
    } finally {
      this.ttlSweeping = false;
    }
  }

  private async stopDock(dock: Dock, orgId: string, callerId: string | null, opts: StopDockInput = {}): Promise<{ id: string; state: DockState }> {
    const id = dock.id;
    if (dock.state === 'archived') return { id: dock.id, state: 'archived' };
    if (dock.state === 'archiving') return { id: dock.id, state: 'archiving' };
    if (!RUNNABLE_STATES.includes(dock.state)) {
      throw new DockConflictException(`Dock in state ${dock.state} cannot stop`);
    }
    // ZDR stops delete the dock, so they need delete rights; checked before any state change.
    const zdr = !opts.force && (await this.retention.policyOn(this.db, orgId));
    if (zdr) {
      if (!callerId) throw new DockConflictException('Docks in a zero data retention organization are not stopped automatically');
      await this.assertCanDelete(dock, callerId, orgId);
    }
    await this.transition(id, [dock.state], { state: 'archiving' });
    if (opts.force) {
      // Best effort: the reconciler destroys the runtime of an archived row if this fails.
      await this.provider.destroyBacking(dock).catch((err) => new Logger('DocksService').warn(`Forced stop destroy failed for ${id}: ${err instanceof Error ? err.message : err}`));
      await this.transition(id, ['archiving'], { state: 'archived' });
      await this.moveToStorage(dock, orgId);
      await this.emitDockEvent('dock.archived', id, dock.workspaceId, orgId, 'archived');
      return { id, state: 'archived' };
    }
    if (zdr) {
      try {
        await this.provider.destroyBacking(dock);
      } catch (err) {
        new Logger('DocksService').error(`ZDR destroyBacking failed for dock ${id}: ${err instanceof Error ? err.message : err}`);
      }
      await this.deleteRows(dock.id);
      await this.metering.closeWindowsForDock(id);
      await this.emitDockEvent('dock.archived', id, dock.workspaceId, orgId, 'archived');
      return { id, state: 'archived' };
    }
    try {
      await this.captureAndArchive(dock, orgId);
    } catch (err) {
      new Logger('DocksService').warn(`Stop capture failed for ${id}: ${err instanceof Error ? err.message : err}`);
      const pausedAt = new Date();
      await this.db
        .update(docks)
        .set({ state: dock.state, billingPausedAt: pausedAt, updatedAt: new Date() })
        .where(and(eq(docks.id, id), eq(docks.state, 'archiving')));
      await this.metering.closeWindowsForDock(id);
      await this.notifications.dockStopRefused({ dockId: id, workspaceId: dock.workspaceId, dockName: dock.name ?? dock.id, at: pausedAt });
      throw new StopRefusedException();
    }
    return { id, state: 'archived' };
  }

  /** Final capture plus archive; shared by stop and boot recovery. */
  private async captureAndArchive(dock: Dock, orgId: string | null): Promise<void> {
    const latest = await this.latestSnapshot(dock.id);
    const capture = await this.provider.captureFinal(dock, latest?.id ?? null);
    await this.recordSnapshot(dock.id, capture.sizeBytes, capture.manifest, latest?.id ?? null, capture.snapshotId, capture.cpuFamily, capture.runtime, capture.kernelRelease, capture.baseFingerprint);
    await this.transition(dock.id, ['archiving'], { state: 'archived' });
    await this.emitDockEvent('dock.archived', dock.id, dock.workspaceId, orgId, 'archived');
    await this.moveToStorage(dock, orgId);
  }

  private async moveToStorage(dock: Dock, orgId: string | null): Promise<void> {
    const organizationId = orgId ?? (await this.orgForWorkspace(dock.workspaceId));
    if (!organizationId) return await this.metering.closeWindowsForDock(dock.id);
    await this.metering.moveToStorage({ organizationId, workspaceId: dock.workspaceId, dockId: dock.id, cpus: dock.cpus, memoryMiB: dock.memoryMiB, diskGiB: dock.diskGiB });
  }

  /**
   * Boot recovery for crash-interrupted transitions. Rows stuck archiving
   * re-drive their final capture (the VM is usually still running); rows
   * stuck provisioning or cloning never reached a live VM and go to error
   * for an explicit retry. Runs once per boot, never blocks it.
   */
  async recoverInterrupted(): Promise<{ archived: number; errored: number }> {
    let archived = 0;
    let errored = 0;
    const stuck = await this.db
      .select()
      .from(docks)
      .where(inArray(docks.state, ['archiving', 'provisioning', 'cloning']));
    for (const dock of stuck) {
      const orgId = await this.orgForWorkspace(dock.workspaceId);
      try {
        if (dock.state === 'archiving') {
          await this.captureWithAdoption(dock, orgId);
          archived += 1;
        } else {
          if (await this.tryTransition(dock.id, [dock.state], { state: 'error' })) {
            await this.emitDockEvent('dock.error', dock.id, dock.workspaceId, orgId, 'error');
            errored += 1;
          }
        }
      } catch (err) {
        new Logger('DocksService').warn(
          `Recovery of ${dock.id} (${dock.state}) failed: ${err instanceof Error ? err.message : err}`,
        );
        if (dock.state === 'archiving') {
          if (await this.tryTransition(dock.id, ['archiving'], { state: 'ready', billingPausedAt: new Date() })) {
            await this.metering.closeWindowsForDock(dock.id);
          }
        } else if (await this.tryTransition(dock.id, [dock.state], { state: 'error' })) {
          await this.emitDockEvent('dock.error', dock.id, dock.workspaceId, orgId, 'error');
          errored += 1;
        }
      }
    }
    return { archived, errored };
  }

  /**
   * Final capture that adopts orphaned generations. The provider reuses one
   * token per archiving episode, so a capture that outlived its caller replays
   * instead of duplicating; while it still runs the docklet answers
   * snapshot_in_progress and recovery waits for it boundedly.
   */
  private async captureWithAdoption(dock: Dock, orgId: string | null): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.captureAndArchive(dock, orgId);
        return;
      } catch (err) {
        if (!isSnapshotInProgress(err) || attempt + 1 >= RECOVERY_CAPTURE_ATTEMPTS) throw err;
        await new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_CAPTURE_RETRY_MS));
      }
    }
  }

  onModuleDestroy(): void {
    if (this.ttlTimer) clearInterval(this.ttlTimer);
  }

  onModuleInit(): void {
    this.ttlTimer = setInterval(
      () => void this.sweepExpiredTtl().catch((err) => new Logger('DocksService').warn(`TTL sweep failed: ${err instanceof Error ? err.message : err}`)),
      TTL_SWEEP_MS,
    );
    this.ttlTimer.unref();
    setImmediate(() => {
      this.recoverInterrupted()
        .then(({ archived, errored }) => {
          if (archived + errored > 0) {
            new Logger('DocksService').log(`Boot recovery: ${archived} archived, ${errored} errored`);
          }
        })
        .catch(() => undefined);
    });
  }

  async resume(callerId: string, id: string, opts: ResumeDockInput = {}): Promise<{ id: string; state: DockState }> {
    const { dock, orgId } = await this.loadReadableDock(callerId, id);
    if (dock.state !== 'archived') throw new DockConflictException('Only archived docks resume');
    const latest = await this.latestSnapshot(id);
    if (!latest || latest.status !== 'completed') {
      throw new DockConflictException('Dock has no completed snapshot to resume from');
    }
    // The host-local latest pointer is gone: resume loads the recorded generation explicitly.
    const snapshotId = latest.storeSnapshotId;
    const size = checkedSize(opts, dock);
    if (opts.ttlSeconds !== undefined && opts.ttlSeconds !== null && (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds < 60 || opts.ttlSeconds > 2592000)) {
      throw validationError('ttlSeconds must be an integer 60..2592000 or null');
    }
    this.requireCapacity(size.diskGiB, dock.diskBytes);
    let environment = dock.environment;
    let envVersionPin = dock.envVersionPin;
    if (opts.environment !== undefined) {
      const resolved = await this.envs.resolveVersion(orgId, opts.environment);
      environment = opts.environment;
      envVersionPin = `v${resolved.version.version}`;
    }
    const noEnv = opts.environment !== undefined ? (opts.noEnv ?? false) : opts.noEnv === true ? true : dock.noEnv;
    // Apply re-runs as the dock's creator, so judge the creator's sign-in, not the resumer's.
    await this.envs.assertSecretsLaunchable(callerId, orgId, environment, { pin: envVersionPin, noEnv, creatorId: dock.createdBy });
    const egressAllow = (await this.envs.egressAllowFor(orgId, environment, envVersionPin)) ?? undefined;
    await this.spendGate.requireSpend(orgId);
    await this.transition(id, ['archived'], { state: 'provisioning', liveSince: null });
    let refused = false;
    try {
      const { machine, runtime } = await this.placeAndRun(egressAllow ? { ...latest, feature: EGRESS_ON_RESUME } : latest, { id, image: dock.image, ...size }, (host) =>
        this.provider.resume({ ...dock, ...size }, { snapshotId, hostId: host?.id ?? null, ...(egressAllow ? { egressAllow } : {}) }),
      ).catch(async (err: unknown) => {
        // Refused before any machine started: the dock stays archived and resumable, not error.
        if (isPlacementRefusal(err)) {
          refused = true;
          await this.db.update(docks).set({ state: 'archived', stateChangedAt: new Date(), updatedAt: new Date() }).where(and(eq(docks.id, id), eq(docks.state, 'provisioning')));
        }
        throw err;
      });
      const set: Partial<typeof docks.$inferInsert> = {
        state: 'ready',
        liveSince: new Date(),
        ip: machine.ip,
        hostId: machine.hostId ?? dock.hostId ?? null,
        runtime: runtime ?? dock.runtime,
        ...size,
        environment,
        envVersionPin,
        noEnv,
        ...(opts.environment !== undefined || noEnv !== dock.noEnv ? { envBoundAt: new Date() } : {}),
        billingPausedAt: null,
        // The TTL clock restarts here: transition stamps stateChangedAt when the dock is ready.
        ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      };
      const resumed = await this.transition(id, ['provisioning'], set);
      await this.metering.moveToCompute({ organizationId: orgId, workspaceId: dock.workspaceId, dockId: id, ...size });
      // Upgrades and posture changes made while archived land now.
      await this.applier.apply(resumed, orgId);
      await this.emitDockEvent('dock.hydrated', id, dock.workspaceId, orgId, 'ready');
      return { id, state: 'ready' };
    } catch (err) {
      if (refused) throw err;
      await this.db.update(docks).set({ state: 'error', stateChangedAt: new Date(), updatedAt: new Date() }).where(eq(docks.id, id));
      await this.emitDockEvent('dock.error', id, dock.workspaceId, orgId, 'error');
      throw err;
    }
  }

  async branch(
    callerId: string,
    id: string,
    opts: BranchDockInput = {},
    idempotencyKey?: string,
  ): Promise<Dock> {
    const { dock, orgId } = await this.loadReadableDock(callerId, id);
    const size = checkedSize(opts, dock);
    const image = opts.image === undefined ? dock.image : checkedImage(opts.image);
    // A branch restores its source's disk, so another image would only relabel it.
    if (image !== dock.image) throw validationError(`A branch keeps its source's image (${dock.image})`);
    const ttlSeconds = opts.ttlSeconds === undefined ? null : opts.ttlSeconds;
    if (ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2592000)) {
      throw validationError('ttlSeconds must be an integer 60..2592000 or null');
    }
    const env = { ...dock.env, ...this.checkedEnv(opts.env ?? {}) };
    let environment = dock.environment;
    let envVersionPin = dock.envVersionPin;
    if (opts.environment !== undefined) {
      const resolved = await this.envs.resolveVersion(orgId, opts.environment);
      environment = opts.environment;
      envVersionPin = `v${resolved.version.version}`;
    }
    const noEnv = opts.environment !== undefined ? (opts.noEnv ?? false) : (opts.noEnv ?? dock.noEnv);
    await this.envs.assertSecretsLaunchable(callerId, orgId, environment, { pin: envVersionPin, noEnv });
    const egressAllow = (await this.envs.egressAllowFor(orgId, environment, envVersionPin)) ?? undefined;
    if (dock.connectors?.length) await this.refuseConnectorMembers(orgId, callerId);
    await this.spendGate.requireSpend(orgId);
    if (idempotencyKey) {
      const existing = await this.claimKey(orgId, idempotencyKey, { source: id, ...size, image, name: opts.name, ttlSeconds, env });
      if (existing) return existing;
    }
    const [target] = await this.withKeyReleased(orgId, idempotencyKey, async () => {
      await this.assertPlaceable(size, { ...(await this.branchSource(dock)), ...(egressAllow ? { feature: EGRESS_ON_RESUME } : {}) });
      return this.insertDock({
        workspaceId: dock.workspaceId,
        name: await this.claimName(dock.workspaceId, opts.name),
        ...size,
        image,
        state: 'provisioning',
        ttlSeconds,
        environment,
        envVersionPin,
        noEnv,
        envBoundAt: new Date(),
        env,
        connectors: dock.connectors,
        fromTemplate: dock.fromTemplate,
        createdBy: callerId,
        setupStatus: 'pending',
      });
    });
    try {
      const latest = await this.latestSnapshot(id);
      const capture = await this.provider.captureSnapshot(dock, latest?.id ?? null);
      await this.recordSnapshot(id, capture.sizeBytes, capture.manifest, latest?.id ?? null, capture.snapshotId, capture.cpuFamily, capture.runtime, capture.kernelRelease, capture.baseFingerprint);
      const { machine, runtime } = await this.placeAndRun(egressAllow ? { ...capture, feature: EGRESS_ON_RESUME } : capture, { id: target.id, image, ...size }, (host) =>
        this.provider.branch(dock, target, { snapshotId: capture.snapshotId, hostId: host?.id ?? null, ...(egressAllow ? { egressAllow } : {}) }),
      );
      const ready = await this.transition(target.id, ['provisioning'], { state: 'ready', liveSince: new Date(), ip: machine.ip, hostId: machine.hostId ?? dock.hostId ?? null, runtime: runtime ?? dock.runtime });
      await this.bindKey(orgId, idempotencyKey, ready.id);
      await this.metering.openWindow({ organizationId: orgId, workspaceId: dock.workspaceId, dockId: ready.id, ...size });
      // The copied disk carries the source's bundle; re-apply for this branch's pin and env.
      const applied = await this.applier.apply(ready, orgId);
      await this.emitDockEvent('dock.ready', ready.id, dock.workspaceId, orgId, 'ready');
      return applied;
    } catch (err) {
      await this.db.update(docks).set({ state: 'error', stateChangedAt: new Date(), updatedAt: new Date() }).where(eq(docks.id, target.id));
      await this.emitDockEvent('dock.error', target.id, dock.workspaceId, orgId, 'error');
      throw err;
    }
  }

  async remove(callerId: string, id: string, confirm?: string): Promise<{ operation: OperationView }> {
    const { dock, orgId } = await this.loadDock(callerId, id);
    await this.assertCanDelete(dock, callerId, orgId);
    if (confirm !== dock.id) throw new ConfirmRequiredException();
    await this.assertNoTemplateBacking(dock.id);
    // Refuses a remove racing a stop, resume, or branch that moved the state since the read.
    await this.touchIfState(dock.id, dock.state);
    const op = await this.ops.create(orgId, 'dock', dock.id);
    try {
      await this.provider.destroyBacking(dock);
    } catch (err) {
      // An unreachable host must not keep billing the removed dock; same pause marker as a refused stop.
      await this.db.update(docks).set({ billingPausedAt: new Date(), updatedAt: new Date() }).where(eq(docks.id, dock.id));
      await this.metering.closeWindowsForDock(dock.id);
      await this.ops.block(op.id);
      throw err;
    }
    await this.deleteRows(dock.id);
    await this.metering.closeWindowsForDock(dock.id);
    return { operation: await this.ops.complete(op.id) };
  }

  /** Members delete only docks they created; org admins delete any. */
  private async assertCanDelete(dock: Dock, callerId: string, orgId: string): Promise<void> {
    if (dock.createdBy === callerId) return;
    try {
      await this.orgs.requireMembership(orgId, callerId, 'admin');
    } catch (err) {
      if (err instanceof ForbiddenException) throw new DockDeleteForbiddenException();
      throw err;
    }
  }

  /** Refuses deletion while a snapshot-only template boots from one of the dock's snapshots. */
  private async assertNoTemplateBacking(dockId: string): Promise<void> {
    const rows = await this.db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.dockId, dockId));
    if (!rows.length) return;
    const [template] = await this.db
      .select({ name: templates.name })
      .from(templates)
      .where(and(inArray(templates.snapshotRef, rows.map((r) => r.id)), isNull(templates.storeSnapshotId)))
      .limit(1);
    if (template) {
      throw new SnapshotInUseException(`A snapshot of this dock is the saved state of template ${template.name}; delete the template first`);
    }
  }

  private async latestSnapshot(dockId: string) {
    const [latest] = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.dockId, dockId))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    return latest ?? null;
  }

  private async recordSnapshot(
    dockId: string,
    sizeBytes: number,
    manifest: unknown,
    parentId: string | null,
    storeSnapshotId?: string,
    cpuFamily?: string,
    runtime?: Runtime | null,
    kernelRelease?: string | null,
    baseFingerprint?: string | null,
  ) {
    const storeId = storeSnapshotId?.startsWith('fake-') ? null : (storeSnapshotId ?? null);
    // A replayed capture must not add a second row pointing at one generation.
    const [existing] = storeId
      ? await this.db.select().from(snapshots).where(and(eq(snapshots.dockId, dockId), eq(snapshots.storeSnapshotId, storeId))).limit(1)
      : [];
    if (existing) return existing;
    const [snap] = await this.db
      .insert(snapshots)
      .values({
        dockId,
        status: 'completed',
        sizeBytes,
        parentId,
        manifest: manifest as never,
        storeSnapshotId: storeId,
        cpuFamily: cpuFamily === 'fake' ? null : (cpuFamily ?? null),
        runtime: runtime ?? null,
        kernelRelease: kernelRelease ?? null,
        baseFingerprint: baseFingerprint ?? null,
      })
      .returning();
    await this.db
      .update(docks)
      .set({ diskBytes: sizeBytes, lastSnapshotAt: new Date(), updatedAt: new Date() })
      .where(eq(docks.id, dockId));
    return snap;
  }

  private async deleteRows(dockId: string): Promise<void> {
    const generations = await orphanedGenerations(this.db, dockId);
    await this.db.delete(snapshots).where(eq(snapshots.dockId, dockId));
    await this.db.delete(docks).where(eq(docks.id, dockId));
    await deleteGenerations(this.provider, dockId, generations);
  }

  /** Shrinking below what the dock holds is refused with the data intact. */
  private requireCapacity(diskGiB: number, diskBytes: number): void {
    if (diskBytes > diskGiB * 1024 ** 3) {
      throw new DockConflictException(`Dock holds more data than ${diskGiB} GiB can take`);
    }
  }

  /** Insert that turns a racing duplicate name into the same 409 as the pre-check. */
  private async insertDock(values: typeof docks.$inferInsert): Promise<Dock[]> {
    try {
      return await this.db.insert(docks).values(values).returning();
    } catch (err) {
      if (isUniqueViolation(err) && values.name) throw new DockNameTakenException(values.name);
      throw err;
    }
  }

  private checkedEnv(env: unknown): Record<string, string> {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw validationError('env must be a string map');
    }
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > MAX_ENV_KEYS) throw validationError('env holds at most 100 variables');
    for (const [k, v] of entries) {
      if (typeof v !== 'string') throw validationError(`env ${k} must be a string`);
      assertNotReserved(k);
    }
    const record = Object.fromEntries(entries) as Record<string, string>;
    if (JSON.stringify(record).length > MAX_ENV_BYTES) throw validationError('env totals at most 64KB');
    return record;
  }

  private parseFilter(filter: string, all: boolean): DockState[] | null {
    if (all) return null;
    if (!/^[rspte]+$/.test(filter)) throw validationError('filter uses state group letters rspte');
    return [...new Set(filter.split('').flatMap((c) => FILTER_GROUPS[c]))];
  }

  /** Outbox write for one lifecycle transition. Recording never fails the transition it follows. */
  private async emitDockEvent(
    type: WebhookEventType,
    dockId: string,
    workspaceId: string,
    orgId: string | null,
    state: DockState,
  ): Promise<void> {
    if (!orgId) return;
    await this.webhooks.record({ type, dockId, organizationId: orgId, workspaceId, state });
  }

  private async orgForWorkspace(workspaceId: string): Promise<string | null> {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    return ws?.organizationId ?? null;
  }

  private async orgIdsFor(callerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, callerId));
    return scopeOrgIds([...new Set(rows.map((r) => r.organizationId))]);
  }

  private async resolveTemplate(orgId: string, name: string): Promise<Template> {
    if (!TEMPLATE_RE.test(name)) throw new TemplateNotFoundException();
    // Scoped to the target workspace's org so a name never reaches another org's template.
    const [tpl] = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.organizationId, orgId), eq(templates.name, name)))
      .limit(1);
    if (tpl && tpl.status === 'ready') return tpl;
    throw new TemplateNotFoundException();
  }

  /** Docklet generation a template boots from: its own capture, else its snapshot's; null boots fresh; a missing snapshot row throws. */
  private async templateSource(tpl: Template): Promise<{ storeId: string | null; cpuFamily: string | null; runtime: Runtime | null; baseFingerprint: string | null }> {
    if (tpl.storeSnapshotId) return { storeId: tpl.storeSnapshotId, cpuFamily: tpl.cpuFamily, runtime: tpl.runtime, baseFingerprint: tpl.baseFingerprint ?? null };
    if (!tpl.snapshotRef) return { storeId: null, cpuFamily: null, runtime: null, baseFingerprint: null };
    const [row] = await this.db.select().from(snapshots).where(eq(snapshots.id, tpl.snapshotRef)).limit(1);
    if (!row) throw new TemplateSourceMissingException(tpl.name);
    return { storeId: row.storeSnapshotId ?? null, cpuFamily: row.cpuFamily ?? null, runtime: row.runtime ?? null, baseFingerprint: row.baseFingerprint ?? null };
  }

  private async claimKey(orgId: string, key: string, body: unknown): Promise<Dock | null> {
    const bodyHash = hashToken(JSON.stringify(body));
    const scope = `org:${orgId}`;
    try {
      await this.db.insert(idempotencyKeys).values({
        scope,
        key,
        bodyHash,
        dockId: null,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });
      return null;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    const [existing] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!existing) return null;
    if (existing.bodyHash !== bodyHash) throw new IdempotencyKeyReusedException();
    if (!existing.dockId) {
      if (existing.createdAt.getTime() < Date.now() - 2 * 60 * 1000) {
        await this.db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
        return this.claimKey(orgId, key, body);
      }
      throw new IdempotencyInProgressException();
    }
    const [dock] = await this.db.select().from(docks).where(eq(docks.id, existing.dockId)).limit(1);
    if (!dock) throw new IdempotencyInProgressException();
    return dock;
  }

  /** Frees a claimed idempotency key when the write fails before any dock exists, so a corrected retry is not stuck in progress. */
  private async withKeyReleased<T>(orgId: string, key: string | undefined, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (key) await this.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, `org:${orgId}`), eq(idempotencyKeys.key, key)));
      throw err;
    }
  }

  private async bindKey(orgId: string, key: string | undefined, dockId: string): Promise<void> {
    if (!key) return;
    await this.db
      .update(idempotencyKeys)
      .set({ dockId })
      .where(and(eq(idempotencyKeys.scope, `org:${orgId}`), eq(idempotencyKeys.key, key)));
  }
}

