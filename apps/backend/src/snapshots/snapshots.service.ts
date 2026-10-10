import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import {
  docks,
  organizationMembers,
  snapshots,
  templates,
  workspaces,
  type Snapshot,
} from '../database/schema';
import { scopeOrgIds } from '../auth/dock-scope';
import { DocksService } from '../docks/docks.service';
import { COMPUTE_PROVIDER, ComputeProvider } from '../docks/compute.provider';
import { DockletException } from '../runtime/docklet.client';
import { DOCKLETS, type DockletFactory } from '../hosts/docklets.factory';
import { OperationsService, type OperationView } from '../retention/operations.service';
import { ConfirmRequiredException, SnapshotInUseException } from '../docks/dock-errors';

export class SnapshotNotFoundException extends NotFoundException {
  constructor(message = 'Snapshot not found') {
    super({ code: 'snapshot_not_found', message });
  }
}

/** Docklet file-read refusals that must reach the caller instead of the manifest fallback. */
function fileReadError(err: DockletException): HttpException | null {
  if (err.code === 'not_a_regular_file') {
    return new UnprocessableEntityException({ code: err.code, message: err.message });
  }
  if (err.code === 'file_too_large') {
    return new PayloadTooLargeException({ code: err.code, message: err.message });
  }
  return null;
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

interface Cursor {
  t: string;
  id: string;
}

function encodeCursor(row: Snapshot): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), id: row.id })).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string' || Number.isNaN(Date.parse(parsed.t))) {
      throw new Error('bad cursor');
    }
    return { t: parsed.t, id: parsed.id };
  } catch {
    throw validationError('Invalid cursor');
  }
}

export interface SnapshotPage {
  snapshots: Snapshot[];
  nextCursor: string | null;
}

/**
 * Automatic snapshot reads/writes. Every read authorizes through the owning
 * dock; only completed snapshots are visible. Folder export arrives with
 * the storage driver; single files stream today.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    private readonly ops: OperationsService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
    @Inject(DOCKLETS) private readonly docklets: DockletFactory,
  ) {}

  async listAll(callerId: string, cursor?: string, limit = 50): Promise<SnapshotPage> {
    const take = this.checkedLimit(limit);
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const dockIds = await this.visibleDockIds(callerId);
    if (!dockIds.length) return { snapshots: [], nextCursor: null };
    return this.page(
      and(inArray(snapshots.dockId, dockIds), ...(after ? [this.cursorPredicate(after)] : [])),
      take,
    );
  }

  async listByDock(callerId: string, dockId: string, cursor?: string, limit = 50): Promise<SnapshotPage> {
    const take = this.checkedLimit(limit);
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const { dock } = await this.docks.loadDock(callerId, dockId);
    return this.page(
      and(eq(snapshots.dockId, dock.id), ...(after ? [this.cursorPredicate(after)] : [])),
      take,
    );
  }

  async latest(callerId: string, dockId: string): Promise<Snapshot | null> {
    const { dock } = await this.docks.loadDock(callerId, dockId);
    const [row] = await this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.dockId, dock.id), eq(snapshots.status, 'completed')))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(1);
    return row ?? null;
  }

  async tree(callerId: string, snapshotId: string): Promise<{ snapshotId: string; files: Array<{ path: string; size: number }> }> {
    const { snap, dock } = await this.completed(callerId, snapshotId);
    return { snapshotId: snap.id, files: await this.listFiles(snap, dock.hostId) };
  }

  async file(
    callerId: string,
    snapshotId: string,
    path: string,
  ): Promise<{ filename: string; size: number; content: string }> {
    const { snap, dock } = await this.completed(callerId, snapshotId);
    if (snap.storeSnapshotId) {
      try {
        // Store content is UTF-8 text; binary files are out of scope.
        const stored = await (await this.docklets(dock.hostId ?? null)).generationFile(snap.storeSnapshotId, path);
        const filename = path.split('/').pop() ?? path;
        return { filename, size: stored.size, content: stored.content };
      } catch (err) {
        if (!(err instanceof DockletException)) throw err;
        const mapped = fileReadError(err);
        if (mapped) throw mapped;
      }
    }
    const entry = snap.manifest.files.find((f) => f.path === path);
    if (!entry) throw new SnapshotNotFoundException(`No such path ${path} in snapshot ${snapshotId}`);
    const filename = path.split('/').pop() ?? path;
    return { filename, size: entry.size, content: entry.content };
  }

  async download(callerId: string, snapshotId: string): Promise<{
    snapshotId: string;
    files: Array<{ path: string; size: number; url: string }>;
  }> {
    const { snap, dock } = await this.completed(callerId, snapshotId);
    const files = await this.listFiles(snap, dock.hostId);
    return {
      snapshotId: snap.id,
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        url: `/v1/snapshots/${snap.id}/files?path=${encodeURIComponent(f.path)}`,
      })),
    };
  }

  async remove(callerId: string, snapshotId: string, confirm?: string): Promise<{ operation: OperationView }> {
    const [snap] = await this.db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).limit(1);
    if (!snap) throw new SnapshotNotFoundException();
    const { orgId } = await this.docks.loadDock(callerId, snap.dockId, 'admin');
    if (confirm !== snap.id) throw new ConfirmRequiredException();
    const [dependent] = await this.db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.parentId, snap.id))
      .limit(1);
    if (dependent) throw new SnapshotInUseException();
    const [template] = await this.db
      .select({ name: templates.name })
      .from(templates)
      .where(eq(templates.snapshotRef, snap.id))
      .limit(1);
    if (template) throw new SnapshotInUseException(`Snapshot is the saved state of template ${template.name}`);
    const op = await this.ops.create(orgId, 'snapshot', snap.id);
    // The store is keyed by the generation id the docklet returned.
    if (snap.storeSnapshotId) await this.provider.deleteBacking(snap.storeSnapshotId);
    await this.db.delete(snapshots).where(eq(snapshots.id, snap.id));
    return { operation: await this.ops.complete(op.id) };
  }
  private async completed(callerId: string, snapshotId: string): Promise<{ snap: Snapshot; dock: { hostId: string | null } }> {
    const [snap] = await this.db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).limit(1);
    if (!snap || snap.status !== 'completed') throw new SnapshotNotFoundException();
    const { dock } = await this.docks.loadReadableDock(callerId, snap.dockId);
    return { snap, dock };
  }

  private async listFiles(snap: Snapshot, hostId: string | null): Promise<Array<{ path: string; size: number }>> {
    if (!snap.storeSnapshotId) return snap.manifest.files.map((f) => ({ path: f.path, size: f.size }));
    try {
      // Older docklets encode an empty tree as null.
      return (await (await this.docklets(hostId)).generationTree(snap.storeSnapshotId)) ?? [];
    } catch (err) {
      // Store outage still serves the manifest.
      if (!(err instanceof DockletException)) throw err;
      return snap.manifest.files.map((f) => ({ path: f.path, size: f.size }));
    }
  }

  private async visibleDockIds(callerId: string): Promise<string[]> {
    const memberships = await this.db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, callerId));
    const orgIds = scopeOrgIds([...new Set(memberships.map((m) => m.organizationId))]);
    if (!orgIds.length) return [];
    const wsRows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.organizationId, orgIds));
    const wsIds = wsRows.map((w) => w.id);
    if (!wsIds.length) return [];
    const dockRows = await this.db
      .select({ id: docks.id })
      .from(docks)
      .where(inArray(docks.workspaceId, wsIds));
    return dockRows.map((d) => d.id);
  }

  private cursorPredicate(after: Cursor) {
    const at = new Date(after.t);
    return or(lt(snapshots.createdAt, at), and(eq(snapshots.createdAt, at), lt(snapshots.id, after.id)));
  }

  private async page(where: ReturnType<typeof and>, take: number): Promise<SnapshotPage> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(where)
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(take + 1);
    const page = rows.slice(0, take);
    return { snapshots: page, nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null };
  }

  private checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validationError('limit must be an integer 1..100');
    return limit;
  }
}
