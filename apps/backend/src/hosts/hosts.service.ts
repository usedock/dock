import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { isInstanceAdmin, isUnverifiedInstanceAdmin, type AdminCandidate } from '../config/instance';
import { DB, Db } from '../database/database.module';
import { hashCredential } from '../fleet/host-command-queue';
import {
  CAPACITY_HOLDING_STATES,
  DEFAULT_CPUS,
  DEFAULT_MEMORY_MIB,
  RUNTIMES,
  docks,
  hosts,
  organizations,
  workspaces,
  type Host,
  type HostWorkload,
  type Runtime,
} from '../database/schema';

export interface RegisterHostInput {
  hostId: string;
  address: string;
  cpuFamily: string;
  kernel: string;
  runtime?: Runtime;
  kernelRelease?: string | null;
  vcpuTotal?: number;
  memTotalBytes?: number;
  memBudgetBytes?: number;
  diskTotalBytes?: number;
  maxDocks: number;
}

export interface HostHeartbeatInput {
  usedDocks?: number;
  /** Last reported runtime inventory; the reconciler's source of truth. */
  running?: HostWorkload[];
  /** Base image fingerprints the host holds; undefined keeps the last report. */
  baseFingerprints?: string[];
  /** Runtime the host reports; undefined keeps the last one. */
  runtime?: Runtime;
}

/** Public API shape of a host; built field by field so new columns are never exposed by default. */
export type HostSummary = Pick<
  Host,
  | 'id'
  | 'address'
  | 'cpuFamily'
  | 'kernel'
  | 'runtime'
  | 'kernelRelease'
  | 'vcpuTotal'
  | 'memTotalBytes'
  | 'diskTotalBytes'
  | 'maxDocks'
  | 'usedDocks'
  | 'state'
  | 'lastHeartbeatAt'
  | 'createdAt'
> & { runningDocks: number };

/** One dock placed on a host, with its owner so admins can tell tenants apart. */
export interface HostDock {
  id: string;
  name: string | null;
  state: string;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
  runtime: string;
  ip: string | null;
  stateChangedAt: Date;
  workspaceName: string;
  organizationId: string;
  organizationName: string;
}

export type HostDetail = HostSummary & {
  docks: HostDock[];
  /** Ephemeral agent-run runtimes; their owner tracks them, not the docks table. */
  runs: HostWorkload[];
  /** Reported runtimes matching no dock row; the reconciler fences these. */
  orphans: HostWorkload[];
};

function summarize(host: Host): HostSummary {
  return {
    id: host.id,
    address: host.address,
    cpuFamily: host.cpuFamily,
    kernel: host.kernel,
    runtime: host.runtime,
    kernelRelease: host.kernelRelease,
    vcpuTotal: host.vcpuTotal,
    memTotalBytes: host.memTotalBytes,
    diskTotalBytes: host.diskTotalBytes,
    maxDocks: host.maxDocks,
    usedDocks: host.usedDocks,
    runningDocks: host.running.length,
    state: host.state,
    lastHeartbeatAt: host.lastHeartbeatAt,
    createdAt: host.createdAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newCredential(): string {
  return `hc_${randomBytes(32).toString('base64url')}`;
}

function alreadyEnrolled(hostId: string): ConflictException {
  return new ConflictException({
    code: 'host_already_enrolled',
    message: `Host ${hostId} is already enrolled; it must use its own credential, or an admin can reset it`,
  });
}

export class HostNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'host_not_found', message: 'Host not found' });
  }
}

/** No eligible host holds the base image a microVM delta generation restores onto. */
export class BaseImageUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      code: 'base_image_unavailable',
      message: 'No host holds the base image this snapshot was captured on; install that base on a host (see DEPLOY.md, golden images)',
    });
  }
}

/**
 * Hosts that can restore onto `fingerprint`, before capacity and exclusions: those reporting it,
 * else those that never reported (unknown); none of either means the base is nowhere to be had.
 */
function holdingBase(rows: Host[], fingerprint: string, cpuFamily: string | null | undefined, runtime: Runtime | null): Host[] {
  const matching = rows.filter((h) => (cpuFamily == null || h.cpuFamily === cpuFamily) && (runtime == null || h.runtime === runtime));
  const holders = matching.filter((h) => h.baseFingerprints?.includes(fingerprint));
  if (holders.length) return holders;
  const unknown = matching.filter((h) => h.baseFingerprints == null);
  if (unknown.length) return unknown;
  if (matching.length) throw new BaseImageUnavailableException();
  return [];
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

/** Host fleet: registration, heartbeats, sweeps, and same-family placement. */
@Injectable()
export class HostsService {
  private readonly logger = new Logger(HostsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  async register(input: RegisterHostInput): Promise<Host> {
    this.checkedRuntime(input.runtime);
    const [existing] = await this.db.select().from(hosts).where(eq(hosts.id, input.hostId)).limit(1);
    if (!existing) {
      const [created] = await this.db
        .insert(hosts)
        .values({
          id: input.hostId,
          address: input.address,
          cpuFamily: input.cpuFamily,
          kernel: input.kernel,
          runtime: input.runtime ?? 'microvm',
          kernelRelease: input.kernelRelease ?? null,
          vcpuTotal: input.vcpuTotal ?? 0,
          memTotalBytes: input.memTotalBytes ?? 0,
          memBudgetBytes: input.memBudgetBytes ?? null,
          diskTotalBytes: input.diskTotalBytes ?? 0,
          maxDocks: input.maxDocks,
          usedDocks: 0,
          state: 'online',
        })
        .returning();
      return created;
    }
    const [updated] = await this.db
      .update(hosts)
      .set({
        address: input.address,
        cpuFamily: input.cpuFamily,
        kernel: input.kernel,
        runtime: input.runtime ?? 'microvm',
        kernelRelease: input.kernelRelease ?? null,
        vcpuTotal: input.vcpuTotal ?? existing.vcpuTotal,
        memTotalBytes: input.memTotalBytes ?? existing.memTotalBytes,
        memBudgetBytes: input.memBudgetBytes ?? existing.memBudgetBytes,
        diskTotalBytes: input.diskTotalBytes ?? existing.diskTotalBytes,
        maxDocks: input.maxDocks,
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, input.hostId))
      .returning();
    return updated;
  }

  /**
   * Issues the per-host fleet credential once: only a host with none yet can be
   * claimed, so the shared token can never take over an enrolled host. The
   * plaintext is returned once and never stored.
   */
  async issueCredential(hostId: string): Promise<string> {
    const credential = newCredential();
    const [claimed] = await this.db
      .update(hosts)
      .set({ credentialHash: hashCredential(credential), updatedAt: new Date() })
      .where(and(eq(hosts.id, hostId), isNull(hosts.credentialHash)))
      .returning({ id: hosts.id });
    if (!claimed) {
      const existing = await this.getById(hostId);
      if (!existing) throw new HostNotFoundException();
      throw alreadyEnrolled(hostId);
    }
    return credential;
  }

  /**
   * Shared-token registration: creates the host, or updates one that holds no
   * credential, in a single conditional write, so an enrolled host is never
   * touched and a losing racer gets 409 before changing any field. Issues the
   * credential in that same write when `issue` is set (the docklet stores it).
   */
  async registerUnenrolled(input: RegisterHostInput, issue: boolean): Promise<string | undefined> {
    this.checkedRuntime(input.runtime);
    const credential = issue ? newCredential() : undefined;
    const credentialHash = credential ? hashCredential(credential) : null;
    const [created] = await this.db
      .insert(hosts)
      .values({
        id: input.hostId,
        address: input.address,
        cpuFamily: input.cpuFamily,
        kernel: input.kernel,
        runtime: input.runtime ?? 'microvm',
        kernelRelease: input.kernelRelease ?? null,
        vcpuTotal: input.vcpuTotal ?? 0,
        memTotalBytes: input.memTotalBytes ?? 0,
        memBudgetBytes: input.memBudgetBytes ?? null,
        diskTotalBytes: input.diskTotalBytes ?? 0,
        maxDocks: input.maxDocks,
        usedDocks: 0,
        state: 'online',
        credentialHash,
      })
      .onConflictDoNothing()
      .returning({ id: hosts.id });
    if (created) return credential;
    const [updated] = await this.db
      .update(hosts)
      .set({
        address: input.address,
        cpuFamily: input.cpuFamily,
        kernel: input.kernel,
        runtime: input.runtime ?? 'microvm',
        kernelRelease: input.kernelRelease ?? null,
        ...(input.vcpuTotal !== undefined ? { vcpuTotal: input.vcpuTotal } : {}),
        ...(input.memTotalBytes !== undefined ? { memTotalBytes: input.memTotalBytes } : {}),
        ...(input.memBudgetBytes !== undefined ? { memBudgetBytes: input.memBudgetBytes } : {}),
        ...(input.diskTotalBytes !== undefined ? { diskTotalBytes: input.diskTotalBytes } : {}),
        maxDocks: input.maxDocks,
        ...(credentialHash ? { credentialHash } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(hosts.id, input.hostId), isNull(hosts.credentialHash)))
      .returning({ id: hosts.id });
    if (!updated) throw alreadyEnrolled(input.hostId);
    return credential;
  }

  /** Enrollment: creates a placeholder row for a new host (registration fills in capacity) and claims its credential. */
  async enrollHost(hostId: string, runtime: Runtime): Promise<string> {
    await this.db
      .insert(hosts)
      .values({ id: hostId, address: 'outbound', cpuFamily: 'unknown', kernel: 'unknown', runtime, maxDocks: 0, usedDocks: 0, state: 'offline' })
      .onConflictDoNothing();
    return this.issueCredential(hostId);
  }

  /** Operator recovery for a host that lost its credential: replaces it and returns the new plaintext once. */
  async resetCredential(user: AdminCandidate, hostId: string): Promise<{ hostId: string; credential: string }> {
    this.requireAdmin(user);
    const credential = newCredential();
    const [updated] = await this.db
      .update(hosts)
      .set({ credentialHash: hashCredential(credential), updatedAt: new Date() })
      .where(eq(hosts.id, hostId))
      .returning({ id: hosts.id });
    if (!updated) throw new HostNotFoundException();
    this.logger.warn(`Host credential reset for ${hostId} by ${user.email}`);
    return { hostId, credential };
  }

  /** The subset of dockIds that are placed on this host; untrusted ids that are not uuids simply drop out. */
  async dockIdsOnHost(hostId: string, dockIds: string[]): Promise<Set<string>> {
    const valid = dockIds.filter((id) => UUID.test(id));
    if (valid.length === 0) return new Set();
    const rows = await this.db.select({ id: docks.id }).from(docks).where(and(eq(docks.hostId, hostId), inArray(docks.id, valid)));
    return new Set(rows.map((row) => row.id));
  }

  async heartbeat(hostId: string, input: HostHeartbeatInput): Promise<Host> {
    const [existing] = await this.db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
    if (!existing) throw new HostNotFoundException();
    this.checkedRuntime(input.runtime);
    const usedDocks = input.usedDocks ?? input.running?.length ?? existing.usedDocks;
    const [updated] = await this.db
      .update(hosts)
      .set({
        usedDocks,
        running: input.running ?? existing.running,
        ...(input.baseFingerprints !== undefined ? { baseFingerprints: input.baseFingerprints } : {}),
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        lastHeartbeatAt: new Date(),
        state: 'online',
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, hostId))
      .returning();
    return updated;
  }

  async sweepOffline(now: Date = new Date(), maxMissed = 3, intervalMs = 30000): Promise<Host[]> {
    const cutoff = new Date(now.getTime() - maxMissed * intervalMs);
    const rows = await this.db.select().from(hosts).where(eq(hosts.state, 'online'));
    const stale = rows.filter((h) => h.state === 'online' && (h.lastHeartbeatAt ?? h.createdAt).getTime() < cutoff.getTime());
    const marked: Host[] = [];
    for (const h of stale) {
      const [updated] = await this.db
        .update(hosts)
        .set({ state: 'offline', updatedAt: now })
        .where(eq(hosts.id, h.id))
        .returning();
      // Flight Recorder event sink plugs in here.
      this.logger.warn(`Host ${h.id} missed heartbeats, marked offline`);
      marked.push(updated ?? { ...h, state: 'offline', updatedAt: now });
    }
    return marked;
  }

  /**
   * Online same-family host with the most headroom that has room for the dock's cpus and memory;
   * null refuses mismatch. Hosts of any runtime qualify unless `runtime` pins one (a restore).
   * Capacity is weighted by each dock's own cpus and memory and reserved in the same transaction:
   * hosts are locked, committed sizes are summed from live docks, and the placed dock's hostId is
   * written before the lock releases, so concurrent placements see each other.
   *
   * A restore from a microVM delta generation (`baseFingerprint`) is placed only on hosts that
   * report holding that base, so it never lands where the restore must fail. Hosts that have
   * not reported their bases yet (older docklets) are a fallback only when none report it;
   * when no candidate can hold it at all, BaseImageUnavailableException is thrown.
   */
  async placeForDock({
    cpuFamily,
    runtime,
    dockId,
    cpus = DEFAULT_CPUS,
    memoryMiB = DEFAULT_MEMORY_MIB,
    excludeHostIds = [],
    baseFingerprint,
  }: {
    cpuFamily?: string | null;
    runtime?: Runtime | null;
    dockId?: string;
    cpus?: number;
    memoryMiB?: number;
    excludeHostIds?: string[];
    baseFingerprint?: string | null;
  }): Promise<Host | null> {
    return this.db.transaction(async (tx) => {
      // Fixed lock order keeps concurrent placements from deadlocking.
      const online = await tx.select().from(hosts).where(eq(hosts.state, 'online')).orderBy(asc(hosts.id)).for('update');
      const rows = baseFingerprint ? holdingBase(online, baseFingerprint, cpuFamily, runtime ?? null) : online;
      const chosen = await this.fitting(tx, rows, { cpuFamily, runtime: runtime ?? null, dockId, cpus, memoryMiB, excludeHostIds });
      if (chosen && dockId) await tx.update(docks).set({ hostId: chosen.id }).where(eq(docks.id, dockId));
      return chosen;
    });
  }

  /** Advisory pre-insert twin of placeForDock: whether a host matching family, runtime and base has room; reserves nothing. */
  async canPlace({ cpuFamily, runtime, baseFingerprint, cpus = DEFAULT_CPUS, memoryMiB = DEFAULT_MEMORY_MIB }: { cpuFamily?: string | null; runtime?: Runtime | null; baseFingerprint?: string | null; cpus?: number; memoryMiB?: number }): Promise<boolean> {
    const online = await this.db.select().from(hosts).where(eq(hosts.state, 'online'));
    const rows = baseFingerprint ? holdingBase(online, baseFingerprint, cpuFamily, runtime ?? null) : online;
    return (await this.fitting(this.db, rows, { cpuFamily, runtime: runtime ?? null, cpus, memoryMiB, excludeHostIds: [] })) !== null;
  }

  /** Any online host with room for the size, ignoring family and runtime; distinguishes exhaustion causes. */
  async anyOnlineWithHeadroom({ cpus = DEFAULT_CPUS, memoryMiB = DEFAULT_MEMORY_MIB, dockId, excludeHostIds = [] }: { cpus?: number; memoryMiB?: number; dockId?: string; excludeHostIds?: string[] } = {}): Promise<boolean> {
    const rows = await this.db.select().from(hosts).where(eq(hosts.state, 'online'));
    return (await this.fitting(this.db, rows, { cpuFamily: null, runtime: null, dockId, cpus, memoryMiB, excludeHostIds })) !== null;
  }

  /** Whether any host is online and whether the size fits some online host's total capacity (unknown totals count as fitting). */
  async sizeFit({ cpus, memoryMiB }: { cpus: number; memoryMiB: number }): Promise<'none_online' | 'too_large' | 'ok'> {
    const rows = await this.db.select().from(hosts).where(eq(hosts.state, 'online'));
    if (rows.length === 0) return 'none_online';
    const fits = rows.some((h) => {
      const memBudget = h.memBudgetBytes ?? h.memTotalBytes;
      const memOk = h.memBudgetBytes === 0 ? false : memBudget <= 0 || memoryMiB * 1024 ** 2 <= memBudget;
      return (h.vcpuTotal <= 0 || cpus <= h.vcpuTotal) && memOk;
    });
    return fits ? 'ok' : 'too_large';
  }

  /** The eligible host with the most headroom whose committed cpus and memory leave room for one more dock of this size. */
  private async fitting(
    q: Pick<Db, 'select'>,
    rows: Host[],
    { cpuFamily, runtime, dockId, cpus, memoryMiB, excludeHostIds }: { cpuFamily?: string | null; runtime: Runtime | null; dockId?: string; cpus: number; memoryMiB: number; excludeHostIds: string[] },
  ): Promise<Host | null> {
    const eligible = rows.filter(
      (h) =>
        h.state === 'online' &&
        !excludeHostIds.includes(h.id) &&
        (cpuFamily == null || h.cpuFamily === cpuFamily) &&
        (runtime == null || h.runtime === runtime),
    );
    if (eligible.length === 0) return null;
    const held = await q
      .select({ hostId: docks.hostId, cpus: docks.cpus, memoryMiB: docks.memoryMiB })
      .from(docks)
      .where(
        and(
          inArray(docks.hostId, eligible.map((h) => h.id)),
          inArray(docks.state, [...CAPACITY_HOLDING_STATES]),
          ...(dockId ? [ne(docks.id, dockId)] : []),
        ),
      );
    const committed = new Map<string, { count: number; cpus: number; memoryMiB: number }>();
    for (const row of held) {
      const sum = committed.get(row.hostId ?? '') ?? { count: 0, cpus: 0, memoryMiB: 0 };
      committed.set(row.hostId ?? '', { count: sum.count + 1, cpus: sum.cpus + row.cpus, memoryMiB: sum.memoryMiB + row.memoryMiB });
    }
    const candidates = eligible
      .map((h) => {
        const sum = committed.get(h.id) ?? { count: 0, cpus: 0, memoryMiB: 0 };
        const used = Math.max(h.usedDocks, sum.count);
        // Null is unknown (fall back to total RAM); a reported 0 means the host has no guest memory.
        const memBudget = h.memBudgetBytes ?? h.memTotalBytes;
        const memFits = h.memBudgetBytes === 0 ? false : memBudget <= 0 || (sum.memoryMiB + memoryMiB) * 1024 ** 2 <= memBudget;
        const fits = used < h.maxDocks && (h.vcpuTotal <= 0 || sum.cpus + cpus <= h.vcpuTotal) && memFits;
        return { host: h, fits, headroom: h.maxDocks - used };
      })
      .filter((c) => c.fits)
      .sort((a, b) => b.headroom - a.headroom);
    return candidates[0]?.host ?? null;
  }

  /** Single host row for per-host routing; null falls back to the default docklet. */
  async getById(hostId: string): Promise<Host | null> {
    const [row] = await this.db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
    return row ?? null;
  }

  /** Every registered host for instance admins; hosts are shared, so org members never see them. */
  async listForAdmin(user: AdminCandidate): Promise<HostSummary[]> {
    this.requireAdmin(user);
    const rows = await this.db.select().from(hosts).orderBy(asc(hosts.id));
    return rows.map(summarize);
  }

  /** One host with every non-archived dock placed on it, across all organizations. */
  async getForAdmin(user: AdminCandidate, hostId: string): Promise<HostDetail> {
    this.requireAdmin(user);
    const host = await this.getById(hostId);
    if (!host) throw new HostNotFoundException();
    const placed = await this.db
      .select({
        id: docks.id,
        name: docks.name,
        state: docks.state,
        cpus: docks.cpus,
        memoryMiB: docks.memoryMiB,
        diskGiB: docks.diskGiB,
        runtime: docks.runtime,
        ip: docks.ip,
        stateChangedAt: docks.stateChangedAt,
        workspaceName: workspaces.name,
        organizationId: organizations.id,
        organizationName: organizations.name,
      })
      .from(docks)
      .innerJoin(workspaces, eq(workspaces.id, docks.workspaceId))
      .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .where(and(eq(docks.hostId, hostId), ne(docks.state, 'archived')))
      .orderBy(asc(docks.name));
    // Same rule as the reconciler: any dock row on this host, archived included, claims its runtime.
    const reported = host.running.filter((w) => w.kind !== 'fast');
    const claimed = reported.length
      ? await this.db
          .select({ id: docks.id })
          .from(docks)
          .where(and(eq(docks.hostId, hostId), inArray(docks.id, reported.map((w) => w.dockId))))
      : [];
    const known = new Set(claimed.map((d) => d.id));
    return {
      ...summarize(host),
      docks: placed,
      runs: host.running.filter((w) => w.kind === 'fast'),
      orphans: reported.filter((w) => !known.has(w.dockId)),
    };
  }

  /** Online hosts for the reconciler tick. */
  async listOnline(): Promise<Host[]> {
    return this.db.select().from(hosts).where(eq(hosts.state, 'online'));
  }

  /** Offline hosts, whose docks the sweep marks unavailable. */
  async listOffline(): Promise<Host[]> {
    return this.db.select().from(hosts).where(eq(hosts.state, 'offline'));
  }

  private requireAdmin(user: AdminCandidate): void {
    if (isUnverifiedInstanceAdmin(this.config, user)) {
      throw new ForbiddenException({ code: 'email_verification_required', message: 'Verify your email to use instance admin features' });
    }
    if (!isInstanceAdmin(this.config, user)) {
      throw new ForbiddenException({ code: 'instance_admin_required', message: 'Only instance admins can manage hosts' });
    }
  }

  /** Only microvm|gvisor register; retired and unknown runtimes fail before any write. */
  private checkedRuntime(runtime: unknown): void {
    if (runtime === undefined) return;
    if (typeof runtime === 'string' && (RUNTIMES as readonly string[]).includes(runtime)) return;
    throw validationError('runtime must be microvm or gvisor');
  }
}
