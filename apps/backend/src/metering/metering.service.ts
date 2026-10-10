import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { DEFAULT_CPUS, DEFAULT_DISK_GIB, DEFAULT_MEMORY_MIB, meteringWindows, type MeteringUnit } from '../database/schema';
import { isUniqueViolation, type OrgTx } from '../organizations/organizations.service';

/** Transition-based activity windows. Fail-open: metering never blocks runtime work and never depends on the spend gate. */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger('MeteringService');

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Opens an activity window recording the dock's size. Fail-open: metering never blocks runtime work. */
  async openWindow(input: {
    organizationId: string;
    workspaceId: string;
    dockId?: string | null;
    runtimeId?: string | null;
    cpus?: number;
    memoryMiB?: number;
    diskGiB?: number;
    executionTarget?: string;
    unit?: MeteringUnit;
    openedAt?: Date;
  }, tx?: OrgTx) {
    const activityId = input.runtimeId ?? input.dockId ?? 'unknown';
    try {
      const insert = (tx ?? this.db).insert(meteringWindows).values({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        dockId: input.dockId ?? null,
        runtimeId: input.runtimeId ?? null,
        unit: input.unit ?? 'compute',
        ...(input.openedAt ? { openedAt: input.openedAt } : {}),
        executionTarget: input.executionTarget ?? 'dock',
        cpus: input.cpus ?? DEFAULT_CPUS,
        memoryMiB: input.memoryMiB ?? DEFAULT_MEMORY_MIB,
        diskGiB: input.diskGiB ?? DEFAULT_DISK_GIB,
      });
      // In a caller's transaction a unique violation would abort it, so conflicts are skipped and errors propagate.
      if (tx) await insert.onConflictDoNothing();
      else await insert;
    } catch (err) {
      if (tx) throw err;
      if (isUniqueViolation(err)) return;
      this.logger.warn(`Metering window dropped for runtime ${activityId}: ${(err as Error).message}`);
    }
  }

  /** Swaps the dock's open window for a storage window: a stopped dock accrues disk only. */
  async moveToStorage(input: {
    organizationId: string;
    workspaceId: string;
    dockId: string;
    cpus: number;
    memoryMiB: number;
    diskGiB: number;
  }, at: Date = new Date(), tx?: OrgTx) {
    await this.swapWindow({ ...input, unit: 'storage' }, at, tx);
  }

  /** Swaps the dock's open window for a compute window: a running dock accrues vCPU, memory and disk. */
  async moveToCompute(input: {
    organizationId: string;
    workspaceId: string;
    dockId: string;
    cpus: number;
    memoryMiB: number;
    diskGiB: number;
  }, at: Date = new Date(), tx?: OrgTx) {
    await this.swapWindow({ ...input, unit: 'compute' }, at, tx);
  }

  /** Close and open share one transaction and one instant, so a failure between them leaves no gap and no stale unit. */
  private async swapWindow(input: {
    organizationId: string;
    workspaceId: string;
    dockId: string;
    cpus: number;
    memoryMiB: number;
    diskGiB: number;
    unit: MeteringUnit;
  }, at: Date, tx?: OrgTx) {
    const swap = async (t: OrgTx) => {
      await this.closeWindowsForDock(input.dockId, at, t);
      await this.openWindow({ ...input, openedAt: at }, t);
    };
    if (tx) return await swap(tx);
    try {
      await this.db.transaction(swap);
    } catch (err) {
      // Fail-open: fall back to best-effort separate writes rather than leave the old unit accruing.
      this.logger.warn(`Metering swap to ${input.unit} failed for dock ${input.dockId}: ${(err as Error).message}`);
      await this.closeWindowsForDock(input.dockId, at);
      await this.openWindow({ ...input, openedAt: at });
    }
  }

  async openFastRunWindow(input: {
    organizationId: string;
    workspaceId: string;
    runtimeId: string;
    cpus?: number;
    memoryMiB?: number;
    diskGiB?: number;
  }) {
    return this.openWindow({ ...input, executionTarget: 'fast' });
  }

  /** Closes open windows so archiving and billing pauses stop accrual. With a tx, failures propagate so the caller's transaction rolls back. */
  async closeWindowsForDock(dockId: string, closedAt: Date = new Date(), tx?: OrgTx) {
    try {
      await (tx ?? this.db)
        .update(meteringWindows)
        .set({ closedAt })
        .where(and(eq(meteringWindows.dockId, dockId), isNull(meteringWindows.closedAt)));
    } catch (err) {
      if (tx) throw err;
      this.logger.warn(`Metering close dropped for dock ${dockId}: ${(err as Error).message}`);
    }
  }

  async closeWindowsForRuntime(runtimeId: string, closedAt: Date = new Date()) {
    try {
      await this.db
        .update(meteringWindows)
        .set({ closedAt })
        .where(and(eq(meteringWindows.runtimeId, runtimeId), isNull(meteringWindows.closedAt)));
    } catch (err) {
      this.logger.warn(`Metering close dropped for runtime ${runtimeId}: ${(err as Error).message}`);
    }
  }
}
