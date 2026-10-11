import { BadRequestException, ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import {
  organizationMembers,
  snapshots,
  templates,
  type Dock,
  type Runtime,
  type Snapshot,
  type Template,
} from '../database/schema';
import { scopeOrgIds } from '../auth/dock-scope';
import { DocksService } from '../docks/docks.service';
import { TEMPLATE_RE, TemplateNotFoundException } from '../docks/dock-errors';
import { COMPUTE_PROVIDER, ComputeProvider } from '../docks/compute.provider';
import { OrganizationsService, type OrgTx } from '../organizations/organizations.service';
import { OperationsService, type OperationView } from '../retention/operations.service';
import { deadlineFromConfig } from '../fleet/host-command-queue';
import { RetentionService, TemplatesBlockedException } from '../retention/retention.service';

export class TemplateLimitReachedException extends ConflictException {
  constructor() {
    super({ code: 'template_limit_reached', message: 'Account keeps at most 10 templates' });
  }
}

export class DockNotRunningException extends ConflictException {
  constructor() {
    super({ code: 'dock_not_running', message: 'Dock is unreachable or in error; wait until it is running or stop it before saving a template' });
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

const MAX_TEMPLATES = 10;
const STALE_MARGIN_MS = 300_000;

/** A save older than the capture deadline plus a margin was abandoned, e.g. by a restart. */
function savingMarker(tpl: Template): Date | null {
  return tpl.savingSince ?? (tpl.status === 'saving' ? tpl.updatedAt : null);
}

/** A dock with connectors holds a gateway token on its disk. */
function hasConnectors(dock: Dock): boolean {
  return (dock.connectors ?? []).length > 0;
}

function saveInFlight(tpl: Template): boolean {
  const marker = savingMarker(tpl);
  if (!marker) return false;
  const limit = deadlineFromConfig('snapshot.create', (k) => process.env[k]) + STALE_MARGIN_MS;
  return Date.now() - marker.getTime() < limit;
}

/**
 * Frozen named dock states. Writes need admin; independent of the source
 * dock once saved; re-saving repoints the name, never touching deployed docks.
 */
@Injectable()
export class TemplatesService {
  private readonly log = new Logger(TemplatesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    private readonly orgs: OrganizationsService,
    private readonly retention: RetentionService,
    private readonly ops: OperationsService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
  ) {}

  async save(callerId: string, dockId: string, rawName: string): Promise<Template> {
    const name = rawName?.trim() ?? '';
    if (!TEMPLATE_RE.test(name)) {
      throw validationError('Template name must be 3-64 lowercase letters, digits, dash, or underscore');
    }
    const { dock, orgId } = await this.docks.loadDock(callerId, dockId, 'admin');
    if (await this.retention.policyOn(this.db, orgId)) throw new TemplatesBlockedException();
    if (dock.state === 'unreachable' || dock.state === 'error') throw new DockNotRunningException();
    const running = dock.state !== 'archived' && dock.state !== 'archiving';
    if (running) return this.saveCaptured(dock, orgId, name);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tpl:${orgId}`}))`);
      const [existing] = await tx
        .select()
        .from(templates)
        .where(and(eq(templates.organizationId, orgId), eq(templates.name, name)))
        .limit(1);
      if (existing && saveInFlight(existing)) throw this.saveInProgress();
      if (!existing) await this.assertUnderLimit(tx, orgId);
      const latest = await this.completedLatest(tx, dock.id);
      if (!latest) throw new ConflictException({ code: 'conflict', message: 'Dock has no completed snapshot' });
      if (existing) {
        await this.releaseGeneration(existing.storeSnapshotId);
        const [updated] = await tx
          .update(templates)
          .set({ ...this.referenced(latest), sourceDockId: dock.id, hadConnectors: hasConnectors(dock), status: 'ready', savingSince: null, updatedAt: new Date() })
          .where(eq(templates.id, existing.id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(templates)
        .values({
          organizationId: orgId,
          name,
          sourceDockId: dock.id,
          hadConnectors: hasConnectors(dock),
          status: 'ready',
          ...this.referenced(latest),
        })
        .returning();
      return created;
    });
  }

  /** Reserves the name in a short transaction, captures outside any transaction, then finalizes. */
  private async saveCaptured(dock: Dock, orgId: string, name: string): Promise<Template> {
    const reservation = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tpl:${orgId}`}))`);
      const [existing] = await tx
        .select()
        .from(templates)
        .where(and(eq(templates.organizationId, orgId), eq(templates.name, name)))
        .limit(1);
      if (existing && saveInFlight(existing)) throw this.saveInProgress();
      if (!existing) await this.assertUnderLimit(tx, orgId);
      const latest = await this.completedLatest(tx, dock.id);
      const reservedAt = new Date();
      if (existing) {
        await tx.update(templates).set({ savingSince: reservedAt }).where(eq(templates.id, existing.id));
        return { id: existing.id, previous: existing, reservedAt, latestId: latest?.id ?? null };
      }
      const [created] = await tx
        .insert(templates)
        .values({ organizationId: orgId, name, sourceDockId: dock.id, hadConnectors: hasConnectors(dock), status: 'saving', savingSince: reservedAt })
        .returning();
      return { id: created.id, previous: null, reservedAt, latestId: latest?.id ?? null };
    });
    let fresh: Awaited<ReturnType<TemplatesService['capture']>>;
    try {
      fresh = await this.capture(dock, reservation.latestId);
    } catch (err) {
      await this.abandonReservation(reservation);
      throw err;
    }
    let saved: Template | undefined;
    try {
      [saved] = await this.db.transaction((tx) =>
        tx
          .update(templates)
          .set({ ...fresh, sourceDockId: dock.id, hadConnectors: hasConnectors(dock), status: 'ready', savingSince: null, updatedAt: new Date() })
          .where(and(eq(templates.id, reservation.id), eq(templates.savingSince, reservation.reservedAt)))
          .returning(),
      );
    } catch (err) {
      try {
        await this.abandonReservation(reservation);
      } finally {
        await this.releaseGenerationQuietly(fresh.storeSnapshotId);
      }
      throw err;
    }
    if (!saved) {
      // The reservation was removed mid-capture, so the new generation has no owner.
      await this.releaseGenerationQuietly(fresh.storeSnapshotId);
      throw new TemplateNotFoundException();
    }
    // The capture holds the source's gateway tokens (connector, LLM); re-applying replaces them so the copies are dead.
    if (hasConnectors(dock) || dock.llmTokenHash) await this.docks.reapply(dock, orgId).catch((err) => this.log.warn(`Could not rotate gateway tokens of dock ${dock.id}: ${(err as Error).message}`));
    // Re-saving replaces the generation, so the old one is released; a failure only leaks it.
    await this.releaseGenerationQuietly(reservation.previous?.storeSnapshotId ?? null);
    return saved;
  }

  private async releaseGenerationQuietly(id: string | null): Promise<void> {
    try {
      await this.releaseGeneration(id);
    } catch (err) {
      this.log.warn(`Could not release template generation ${id}: ${(err as Error).message}`);
    }
  }

  /** Deletes a fresh reservation, or restores a re-saved row; only while this save still owns it. */
  private async abandonReservation(r: { id: string; previous: Template | null; reservedAt: Date }): Promise<void> {
    const owned = and(eq(templates.id, r.id), eq(templates.savingSince, r.reservedAt));
    try {
      if (r.previous) {
        const status = r.previous.status === 'saving' ? 'failed' : r.previous.status;
        await this.db.update(templates).set({ status, savingSince: null, updatedAt: new Date() }).where(owned);
      } else {
        await this.db.delete(templates).where(owned);
      }
    } catch {
      // Best effort; a stuck saving row is cleared by deleting the template.
    }
  }

  private async assertUnderLimit(tx: OrgTx, orgId: string): Promise<void> {
    const count = await tx.select({ id: templates.id }).from(templates).where(eq(templates.organizationId, orgId));
    if (count.length >= MAX_TEMPLATES) throw new TemplateLimitReachedException();
  }

  private saveInProgress(): ConflictException {
    return new ConflictException({ code: 'conflict', message: 'A template with this name is already being saved' });
  }

  async list(callerId: string): Promise<Template[]> {
    const orgIds = await this.orgIdsFor(callerId);
    if (!orgIds.length) return [];
    return this.db
      .select()
      .from(templates)
      .where(inArray(templates.organizationId, orgIds))
      .orderBy(desc(templates.createdAt));
  }

  async get(callerId: string, orgId: string, name: string): Promise<Template> {
    await this.orgs.requireMembership(orgId, callerId);
    const tpl = await this.findByName(this.db, orgId, name);
    if (tpl.status !== 'ready') throw new TemplateNotFoundException();
    return tpl;
  }

  async remove(callerId: string, orgId: string, name: string): Promise<{ operation: OperationView }> {
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    // Looked up in any status so admins can clear saving and failed rows.
    const tpl = await this.findByName(this.db, orgId, name);
    const op = await this.ops.create(tpl.organizationId, 'template', tpl.id);
    // The lock keeps the delete from racing a finalize that is writing the generation.
    const current = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tpl:${tpl.organizationId}`}))`);
      const [row] = await tx.select().from(templates).where(eq(templates.id, tpl.id)).limit(1);
      await tx.delete(templates).where(eq(templates.id, tpl.id));
      return row ?? tpl;
    });
    // Only this template's own generation goes away; a generation it merely
    // referenced belongs to a snapshot row and is left intact.
    await this.releaseGenerationQuietly(current.storeSnapshotId);
    return { operation: await this.ops.complete(op.id) };
  }

  private async findByName(executor: Db | OrgTx, orgId: string, name: string): Promise<Template> {
    const [tpl] = await executor
      .select()
      .from(templates)
      .where(and(eq(templates.organizationId, orgId), eq(templates.name, name)))
      .limit(1);
    if (!tpl) throw new TemplateNotFoundException();
    return tpl;
  }

  private async completedLatest(executor: OrgTx, dockId: string) {
    const [latest] = await executor
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.dockId, dockId), eq(snapshots.status, 'completed')))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(1);
    return latest ?? null;
  }

  private async capture(
    dock: Dock,
    parentId: string | null,
  ): Promise<{ snapshotRef: string | null; sizeBytes: number; storeSnapshotId: string; cpuFamily: string; runtime: Runtime | null; baseFingerprint: string | null }> {
    try {
      const capture = await this.provider.captureSnapshot(dock, parentId);
      // The generation is kept so the template owns it: dropping the id would
      // leave the objects in the store with nothing able to delete them.
      return {
        snapshotRef: parentId,
        sizeBytes: capture.sizeBytes,
        storeSnapshotId: capture.snapshotId,
        cpuFamily: capture.cpuFamily,
        runtime: capture.runtime,
        baseFingerprint: capture.baseFingerprint ?? null,
      };
    } catch {
      throw new ServiceUnavailableException({ code: 'service_unavailable', message: 'Template capture failed' });
    }
  }

  /** Points at a snapshot's generation without owning one. */
  private referenced(snap: Snapshot) {
    return { snapshotRef: snap.id, sizeBytes: snap.sizeBytes, storeSnapshotId: null, cpuFamily: null, runtime: null, baseFingerprint: null };
  }

  /** Drops a generation a template previously owned, best effort. */
  private async releaseGeneration(previous: string | null): Promise<void> {
    if (!previous) return;
    await this.provider.deleteBacking(previous);
  }

  private async orgIdsFor(callerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, callerId));
    return scopeOrgIds([...new Set(rows.map((r) => r.organizationId))]);
  }
}
