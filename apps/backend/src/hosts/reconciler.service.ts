import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { docks, workspaces, type Dock, type DockState } from '../database/schema';
import { DOCKLETS, type DockletFactory } from './docklets.factory';
import { HostsService } from './hosts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MeteringService } from '../metering/metering.service';

/** States in which the host must be reporting the dock in its inventory. */
const LIVE_STATES: ReadonlySet<DockState> = new Set(['ready', 'idle', 'running']);
/** A dock must have been live this long before the last heartbeat to count as missing. */
export const MISSING_GRACE_MS = 30_000;

/** Offline hosts are swept this often; hosts.sweepOffline decides who is stale. */
const SWEEP_MS = 30_000;
/** No offline sweep until every host has had three heartbeat intervals to check in after boot. */
export const BOOT_GRACE_MS = 90_000;
/** Docklet rescan interval; an unreachable dock absent from one inventory is not yet gone. */
export const RESCAN_MS = 60_000;

export interface ReconcileResult {
  fenced: string[];
  errored: string[];
  recovered: string[];
}

/**
 * Host-truth repairs run direct on rows; operations stay on the user path.
 *
 * The host's own heartbeat inventory is the comparison source: it is the last
 * thing the machine actually reported, so repair never depends on a host being
 * reachable at reconcile time. Destroy, when needed, goes through the command
 * channel like every other host operation.
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private readonly bootAt = Date.now();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hosts: HostsService,
    @Inject(DOCKLETS) private readonly docklets: DockletFactory,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly metering: MeteringService,
  ) {}

  async runOnce(hostId: string): Promise<ReconcileResult> {
    const host = await this.hosts.getById(hostId);
    if (!host) throw new Error(`unknown host ${hostId}`);
    const rows = await this.db.select().from(docks).where(eq(docks.hostId, hostId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const reported = host.running ?? [];
    const seen = new Set(reported.map((vm) => vm.dockId));
    const fenced: string[] = [];
    const errored: string[] = [];
    const recovered: string[] = [];
    const client = await this.docklets(hostId);
    for (const vm of reported) {
      // Ephemeral agent runs are tracked by their owner, never the docks table.
      if (vm.kind === 'fast') continue;
      // An archived row keeps no runtime; destroy what a forced stop or failed destroy left behind.
      if (byId.has(vm.dockId) && byId.get(vm.dockId)?.state !== 'archived') continue;
      try {
        await client.destroy(vm.dockId);
        // Flight Recorder event sink plugs in here.
        this.logger.warn(`Fenced orphan or archived runtime ${vm.dockId} on host ${hostId}`);
        fenced.push(vm.dockId);
      } catch (err) {
        this.logger.warn(`Fence of orphan ${vm.dockId} on host ${hostId} failed: ${(err as Error).message}`);
      }
    }
    // Docks that went live after the last heartbeat may not be in its inventory yet.
    const cutoff = host.lastHeartbeatAt ? host.lastHeartbeatAt.getTime() - MISSING_GRACE_MS : null;
    for (const row of rows) {
      if ((row.state === 'unreachable' || row.state === 'error') && seen.has(row.id)) {
        // A boot that failed before ever going live is fenced, not revived with billing.
        if (row.state === 'error' && !row.liveSince) {
          try {
            await client.destroy(row.id);
            this.logger.warn(`Fenced never-live errored dock ${row.id} on host ${hostId}`);
            fenced.push(row.id);
          } catch (err) {
            this.logger.warn(`Fence of never-live dock ${row.id} on host ${hostId} failed: ${(err as Error).message}`);
          }
          continue;
        }
        if (await this.recover(row)) recovered.push(row.id);
        continue;
      }
      if (!(LIVE_STATES.has(row.state) || row.state === 'unreachable') || seen.has(row.id)) continue;
      // A rescan after the host returns can miss a VM for one pass, so unreachable rows wait one more interval.
      const wait = row.state === 'unreachable' ? RESCAN_MS : 0;
      if (cutoff === null || row.stateChangedAt.getTime() > cutoff - wait) continue;
      if (await this.markError(row, `missing on host ${hostId}`)) errored.push(row.id);
    }
    return { fenced, errored, recovered };
  }

  /** Conditional on the state and stamp read, so a concurrent stop or resume wins; billing closes with the state. */
  private async markError(row: Dock, why: string, to: 'error' | 'unreachable' = 'error'): Promise<boolean> {
    const at = new Date();
    const changed = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(docks)
        .set({ state: to, stateChangedAt: at, updatedAt: at })
        .where(and(eq(docks.id, row.id), eq(docks.state, row.state), eq(docks.stateChangedAt, row.stateChangedAt)))
        .returning({ id: docks.id });
      if (!updated.length) return false;
      await this.metering.closeWindowsForDock(row.id, at, tx);
      return true;
    });
    if (!changed) return false;
    // Flight Recorder event sink plugs in here.
    this.logger.warn(`Dock ${row.id} ${why}, marked ${to}`);
    try {
      await this.notifications.dockStoppedResponding({ dockId: row.id, workspaceId: row.workspaceId, dockName: row.name ?? row.id, at });
    } catch (err) {
      this.logger.warn(`Notification for dock ${row.id} failed: ${(err as Error).message}`);
    }
    return true;
  }

  /** A host reports the dock running again (after an outage or a stuck error): back to ready, billing reopened unless a refused stop paused it. */
  private async recover(row: Dock): Promise<boolean> {
    const at = new Date();
    const changed = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(docks)
        .set({ state: 'ready', stateChangedAt: at, updatedAt: at })
        .where(and(eq(docks.id, row.id), eq(docks.state, row.state), eq(docks.stateChangedAt, row.stateChangedAt)))
        .returning({ id: docks.id });
      if (!updated.length) return false;
      if (row.billingPausedAt) return true;
      const [ws] = await tx.select({ organizationId: workspaces.organizationId }).from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1);
      if (ws) await this.metering.openWindow({ organizationId: ws.organizationId, workspaceId: row.workspaceId, dockId: row.id, cpus: row.cpus, memoryMiB: row.memoryMiB, diskGiB: row.diskGiB }, tx);
      return true;
    });
    if (changed) this.logger.warn(`Dock ${row.id} reported again by its host, recovered to ready`);
    return changed;
  }

  /** Marks stale hosts offline, then marks the live docks of every offline host unreachable and stops their billing. */
  async sweepOfflineHosts(now: number = Date.now()): Promise<string[]> {
    if (now - this.bootAt < BOOT_GRACE_MS) return [];
    await this.hosts.sweepOffline();
    const errored: string[] = [];
    for (const host of await this.hosts.listOffline()) {
      const rows = await this.db
        .select()
        .from(docks)
        .where(and(eq(docks.hostId, host.id), inArray(docks.state, [...LIVE_STATES])));
      for (const row of rows) {
        try {
          if (await this.markError(row, `on offline host ${host.id}`, 'unreachable')) errored.push(row.id);
        } catch (err) {
          this.logger.warn(`Marking dock ${row.id} unreachable failed: ${(err as Error).message}`);
        }
      }
    }
    return errored;
  }

  onModuleInit(): void {
    const raw = Number(this.config.get<string>('RUNTIME_RECONCILE_MS') ?? 60000);
    const ms = Number.isFinite(raw) && raw > 0 ? raw : 60000;
    this.timer = setInterval(() => void this.reconcileAll(), ms);
    this.timer.unref();
    this.sweepTimer = setInterval(
      () => void this.sweepOfflineHosts().catch((err) => this.logger.warn(`Offline sweep failed: ${(err as Error).message}`)),
      SWEEP_MS,
    );
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async reconcileAll(): Promise<void> {
    const online = await this.hosts.listOnline();
    for (const h of online) {
      try {
        await this.runOnce(h.id);
      } catch (err) {
        this.logger.warn(`Reconcile of host ${h.id} failed: ${(err as Error).message}`);
      }
    }
  }
}
