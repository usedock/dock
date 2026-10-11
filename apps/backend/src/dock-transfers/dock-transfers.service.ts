import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { newUuid } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { DOCK_IMAGES, apiKeys, dockExports, dockImports, docks, workspaces, type Dock, type DockExport, type DockImport } from '../database/schema';
import { COMPUTE_PROVIDER, ComputeProvider } from '../docks/compute.provider';
import { DockNameTakenException, DockNotFoundException, DockNotRunningException } from '../docks/dock-errors';
import { DocksService, checkedSize } from '../docks/docks.service';
import { EnvironmentsService } from '../environments/environments.service';
import { FleetObjectsService } from '../fleet/fleet-objects.service';
import { deadlineFromConfig } from '../fleet/host-command-queue';
import { VERIFIED_IMPORTS } from '../hosts/host-features';
import { HostsService } from '../hosts/hosts.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RetentionService } from '../retention/retention.service';
import { WorkspaceNotFoundException, WorkspacesService } from '../workspaces/workspaces.service';
import {
  EXPORT_BASE_UNSUPPORTED,
  EXPORT_FAILED,
  EXPORT_INTERRUPTED,
  ExportNotFoundException,
  ImportChecksumMismatchException,
  ImportNotFoundException,
  ImportTooLargeException,
  RuntimeUnsupportedException,
  TransferLimitException,
} from './dock-transfer-errors';

/** The one object of an import or export generation. */
export const DISK_OBJECT = 'rootfs.ext4.zst';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Parts below this are slow on the wire; larger disks grow the part size to stay under the S3 part cap. */
const MIN_PART_SIZE = 16 * MIB;
const MAX_PARTS = 10000;
/** A proxied part is buffered whole in memory, so it stays modest. */
const MAX_PROXY_PART_SIZE = 128 * MIB;
const MAX_OPEN_IMPORTS = 5;
const MAX_LIVE_EXPORTS = 5;
const SWEEP_MS = 10 * 60_000;
const SWEEP_BATCH = 50;
const STALE_MARGIN_MS = 300_000;
const STALE_COMPLETING_MS = 3_600_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Refusals of the boot placement; the assembled upload survives them so complete can be retried. */
const RETRYABLE_CODES = ['no_host_capacity', 'capacity_exhausted', 'base_image_unavailable', 'image_unavailable', 'dock_name_taken'];

export interface ImportInput {
  workspaceId: string;
  name?: string;
  image: string;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
  sizeBytes: number;
  sha256: string;
}

export interface ImportStarted {
  importId: string;
  upload: { mode: 'direct' | 'proxy'; partSize: number; parts: Array<{ number: number; url: string }> };
}

export interface ExportView {
  state: DockExport['state'];
  error?: string;
  image: string;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
  sizeBytes: number | null;
  sha256: string | null;
  baseImage: string | null;
  url: string | null;
  /** When the export and its object are removed. */
  expiresAt: Date;
  /** When `url` stops working; a fresh GET issues a new one. */
  urlExpiresAt: Date | null;
}

interface DockTokens {
  llm: string | null;
  connector: string | null;
  keyIds: string[];
}

export interface DownloadHandle {
  stream: NodeJS.ReadableStream;
  size: number;
  start: number;
  end: number;
  partial: boolean;
}

/** Part size for a disk: the floor, or larger when the part count would pass the S3 cap. */
export function partSizeFor(sizeBytes: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(sizeBytes / MAX_PARTS / MIB) * MIB);
}

export function exportDownloadPath(exportId: string): string {
  return `/v1/docks/exports/${exportId}/download`;
}

/** The manifest the docklet materializes the upload from; cpuFamily must be the placed host's, as the docklet refuses any other. */
export function wholeImageManifest(row: Pick<DockImport, 'id' | 'storeSnapshotId' | 'sizeBytes' | 'sha256' | 'image'>, cpuFamily = ''): Record<string, unknown> {
  return {
    snapshotId: row.storeSnapshotId,
    dockId: row.id,
    parentId: null,
    kind: 'full',
    cpuFamily,
    image: row.image,
    // Tells the docklet the bytes came from a client, so a missing checksum is an error rather than a legacy generation.
    source: 'import',
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    files: [{ path: DISK_OBJECT, size: row.sizeBytes, encoding: 'zstd', sha256: row.sha256 }],
  };
}

/** One `bytes=start-[end]` range; null when absent or malformed (the whole object is sent). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header.trim()) : null;
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Disk upload (push) and disk download (pull): bookkeeping around the snapshot store and the dock lifecycle. */
@Injectable()
export class DockTransfersService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DockTransfersService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly workspaces: WorkspacesService,
    private readonly docks: DocksService,
    private readonly envs: EnvironmentsService,
    private readonly objects: FleetObjectsService,
    private readonly hosts: HostsService,
    private readonly retention: RetentionService,
    private readonly config: ConfigService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweep().catch((err) => this.log.warn(`Transfer sweep failed: ${(err as Error).message}`)), SWEEP_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // Import

  async startImport(callerId: string, input: ImportInput): Promise<ImportStarted> {
    const size = checkedSize(input);
    if (typeof input.image !== 'string' || !DOCK_IMAGES.includes(input.image)) {
      throw new BadRequestException({ code: 'image_unknown', message: `Unknown image. Valid images: ${DOCK_IMAGES.join(', ')}` });
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1) throw validationError('sizeBytes must be a positive integer');
    if (!SHA256_RE.test(input.sha256)) throw validationError('sha256 must be 64 lowercase hex characters');
    // A compressed image cannot outgrow the raw disk it came from.
    const limit = size.diskGiB * GIB;
    if (input.sizeBytes > limit) throw new ImportTooLargeException(`sizeBytes ${input.sizeBytes} exceeds the ${size.diskGiB} GiB disk (${limit} bytes)`);
    const ws = await this.workspaces.getById(callerId, input.workspaceId).catch((err) => {
      if (err instanceof WorkspaceNotFoundException) throw new DockNotFoundException();
      throw err;
    });
    const orgId = ws.organizationId;
    // The same gate complete meets in docks.create, so a refused member does not upload a disk first; imports carry no connectors.
    await this.envs.assertSecretsLaunchable(callerId, orgId, undefined);
    await this.assertMicroVmHost();
    if (input.name !== undefined) await this.assertNameFree(input.workspaceId, input.name);
    const [{ open }] = await this.db
      .select({ open: count() })
      .from(dockImports)
      .where(and(eq(dockImports.organizationId, orgId), inArray(dockImports.status, ['uploading', 'completing', 'uploaded'])));
    if (open >= MAX_OPEN_IMPORTS) throw new TransferLimitException('import_limit_reached', `At most ${MAX_OPEN_IMPORTS} imports can be open at once; complete one or wait for it to expire`);

    const mode = this.objects.directTransfers ? 'direct' : 'proxy';
    const partSize = partSizeFor(input.sizeBytes);
    if (mode === 'proxy' && partSize > MAX_PROXY_PART_SIZE) {
      throw new ImportTooLargeException(`This disk is too large to upload through the control plane (${input.sizeBytes} bytes); configure SNAPSHOT_STORE_PUBLIC_ENDPOINT for direct uploads`);
    }
    const partCount = Math.ceil(input.sizeBytes / partSize);
    const generation = newUuid();
    const uploadId = await this.objects.startUpload(generation, DISK_OBJECT);
    let row: DockImport;
    try {
      [row] = await this.db
        .insert(dockImports)
        .values({
          organizationId: orgId,
          workspaceId: input.workspaceId,
          createdBy: callerId,
          name: input.name?.trim() || null,
          image: input.image,
          ...size,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          storeSnapshotId: generation,
          uploadId,
          mode,
          partSize,
          partCount,
          expiresAt: new Date(Date.now() + DAY_MS),
        })
        .returning();
    } catch (err) {
      await this.objects.abortUpload(generation, DISK_OBJECT, uploadId).catch(() => undefined);
      throw err;
    }
    const numbers = Array.from({ length: partCount }, (_unused, index) => index + 1);
    // Direct part URLs live as long as the import so a long upload never outruns its later URLs.
    const parts =
      mode === 'direct'
        ? await Promise.all(numbers.map(async (number) => ({ number, url: await this.objects.presignPart(generation, DISK_OBJECT, uploadId, number, DAY_MS / 1000) })))
        : numbers.map((number) => ({ number, url: `/v1/docks/import/${row.id}/parts/${number}` }));
    return { importId: row.id, upload: { mode, partSize, parts } };
  }

  /** Stores one proxied part; the body is buffered, so it is capped at the announced part size. */
  async putPart(callerId: string, importId: string, number: number, body: AsyncIterable<Buffer | string>, declaredLength?: number): Promise<{ number: number; etag: string }> {
    const row = await this.loadImport(callerId, importId);
    if (row.status !== 'uploading' || row.expiresAt.getTime() < Date.now()) throw new ConflictException({ code: 'conflict', message: 'Import is no longer accepting parts' });
    if (row.mode !== 'proxy') throw new ConflictException({ code: 'conflict', message: 'This import uploads straight to the store; use the part URLs from the import response' });
    if (!Number.isInteger(number) || number < 1 || number > row.partCount) throw validationError(`part number must be 1..${row.partCount}`);
    if (declaredLength !== undefined && declaredLength > row.partSize) throw partTooLarge(row.partSize);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > row.partSize) throw partTooLarge(row.partSize);
      chunks.push(buf);
    }
    if (total === 0) throw validationError('part body is empty');
    const etag = await this.objects.uploadPart(row.storeSnapshotId, DISK_OBJECT, row.uploadId, number, Buffer.concat(chunks));
    return { number, etag };
  }

  /** Assembles the upload, records it as a whole-image generation and boots a dock from it. */
  async completeImport(callerId: string, importId: string, parts: Array<{ number: number; etag: string }>): Promise<Dock> {
    const row = await this.loadImport(callerId, importId);
    if (row.status === 'completed' && row.dockId) return this.existingDock(row.dockId);
    if (row.status === 'failed' || row.expiresAt.getTime() < Date.now()) {
      throw new ConflictException({ code: 'conflict', message: 'Import failed or expired; start a new import' });
    }
    // Only an open upload takes parts; an assembled one (a retry after a placement refusal) is reused as is.
    const sorted = row.status === 'uploading' ? checkedParts(parts, row.partCount) : [];
    const [claimed] = await this.db
      .update(dockImports)
      .set({ status: 'completing', updatedAt: new Date() })
      .where(and(eq(dockImports.id, row.id), inArray(dockImports.status, ['uploading', 'uploaded'])))
      .returning({ id: dockImports.id });
    if (!claimed) throw new ConflictException({ code: 'conflict', message: 'Import is already being completed' });
    if (row.status === 'uploading') await this.assemble(row, sorted);
    return this.createDock(callerId, row);
  }

  private async assemble(row: DockImport, parts: Array<{ number: number; etag: string }>): Promise<void> {
    try {
      await this.objects.completeUpload(row.storeSnapshotId, DISK_OBJECT, row.uploadId, parts.map((p) => ({ part: p.number, etag: p.etag })));
      const size = await this.objects.objectSize(row.storeSnapshotId, DISK_OBJECT);
      if (size !== row.sizeBytes) {
        const message = `uploaded ${size ?? 0} bytes, declared ${row.sizeBytes}`;
        throw size !== null && size > row.diskGiB * GIB ? new ImportTooLargeException(message) : new ImportChecksumMismatchException(message);
      }
      await this.writeManifest(row, '');
    } catch (err) {
      await this.failImport(row, err);
      throw err;
    }
  }

  private async createDock(callerId: string, row: DockImport): Promise<Dock> {
    try {
      const dock = await this.docks.create(callerId, {
        workspaceId: row.workspaceId,
        ...(row.name ? { name: row.name } : {}),
        image: row.image,
        cpus: row.cpus,
        memoryMiB: row.memoryMiB,
        diskGiB: row.diskGiB,
        importedGeneration: {
          storeSnapshotId: row.storeSnapshotId,
          sizeBytes: row.sizeBytes,
          manifest: { files: [] },
          onPlaced: async (host) => {
            if (host) await this.writeManifest(row, host.cpuFamily);
          },
          onBootFailed: (err) => this.recordBootFailure(row.id, err),
        },
      });
      await this.db.update(dockImports).set({ status: 'completed', dockId: dock.id, updatedAt: new Date() }).where(eq(dockImports.id, row.id));
      return dock;
    } catch (err) {
      if (RETRYABLE_CODES.includes(errorCode(err) ?? '')) {
        await this.db.update(dockImports).set({ status: 'uploaded', updatedAt: new Date() }).where(eq(dockImports.id, row.id));
      } else {
        await this.failImport(row, err);
      }
      throw err;
    }
  }

  private async writeManifest(row: DockImport, cpuFamily: string): Promise<void> {
    await this.objects.putSmallObject(row.storeSnapshotId, 'manifest.json', Buffer.from(JSON.stringify(wholeImageManifest(row, cpuFamily))));
  }

  private async recordBootFailure(importId: string, err: unknown): Promise<void> {
    const code = (err as { code?: unknown }).code;
    const checksum = code === 'import_checksum_mismatch' || code === 'checksum_mismatch';
    await this.db
      .update(dockImports)
      .set({ status: 'failed', error: checksum ? 'import_checksum_mismatch' : 'boot_failed', updatedAt: new Date() })
      .where(eq(dockImports.id, importId));
  }

  /** Marks the import failed and drops what it uploaded; the generation is the import's own until a snapshot row takes it. */
  private async failImport(row: DockImport, err: unknown): Promise<void> {
    await this.db
      .update(dockImports)
      .set({ status: 'failed', error: errorCode(err) ?? 'import_failed', updatedAt: new Date() })
      .where(eq(dockImports.id, row.id))
      .catch(() => undefined);
    await this.discardUpload(row).catch((cleanup) => this.log.warn(`Could not remove import ${row.id} objects: ${(cleanup as Error).message}`));
  }

  private async discardUpload(row: DockImport): Promise<void> {
    await this.objects.abortUpload(row.storeSnapshotId, DISK_OBJECT, row.uploadId);
    await this.objects.deleteGeneration(row.storeSnapshotId);
  }

  /** An upload session belongs to the member who opened it. */
  private async loadImport(callerId: string, importId: string): Promise<DockImport> {
    if (!UUID_RE.test(importId)) throw new ImportNotFoundException();
    const [row] = await this.db.select().from(dockImports).where(eq(dockImports.id, importId)).limit(1);
    if (!row || row.createdBy !== callerId) throw new ImportNotFoundException();
    try {
      await this.orgs.requireMembership(row.organizationId, callerId);
    } catch {
      throw new ImportNotFoundException();
    }
    return row;
  }

  private async existingDock(dockId: string): Promise<Dock> {
    const [dock] = await this.db.select().from(docks).where(eq(docks.id, dockId)).limit(1);
    if (!dock) throw new DockNotFoundException();
    return dock;
  }

  private async assertNameFree(workspaceId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100) throw validationError('Name must be 1-100 characters');
    const [taken] = await this.db.select({ id: docks.id }).from(docks).where(and(eq(docks.workspaceId, workspaceId), eq(docks.name, trimmed))).limit(1);
    if (taken) throw new DockNameTakenException(trimmed);
  }

  /** Real fleets only: the fake driver places nothing, so tests and dev boxes pass. */
  private async assertMicroVmHost(): Promise<void> {
    if (this.config.get<string>('RUNTIME_DRIVER') !== 'restate') return;
    const online = await this.hosts.listOnline();
    if (!online.some((host) => host.runtime === 'microvm')) throw new RuntimeUnsupportedException();
    if (!online.some((host) => host.runtime === 'microvm' && host.features.includes(VERIFIED_IMPORTS))) {
      throw new RuntimeUnsupportedException('No microVM host verifies imported disks yet; upgrade the docklets');
    }
  }

  // Export

  async startExport(callerId: string, dockId: string): Promise<{ exportId: string }> {
    // Same gate as opening the dock: connector and admins-only environment rules apply to its disk.
    const { dock, orgId } = await this.docks.loadReadableDock(callerId, dockId);
    if (await this.retention.policyOn(this.db, orgId)) {
      throw new ForbiddenException({ code: 'zdr_blocks_exports', message: 'Exports are disabled while retention is enabled' });
    }
    if (dock.runtime !== 'microvm') throw new RuntimeUnsupportedException('Only microVM docks can be exported; a gVisor dock keeps just its work directory');
    if (!['ready', 'idle', 'running'].includes(dock.state)) throw new DockNotRunningException(dock.state);
    const now = new Date();
    const live = await this.db
      .select({ dockId: dockExports.dockId, state: dockExports.state })
      .from(dockExports)
      .where(and(eq(dockExports.organizationId, orgId), inArray(dockExports.state, ['pending', 'ready']), sql`${dockExports.expiresAt} > ${now}`));
    if (live.some((e) => e.dockId === dock.id && e.state === 'pending')) {
      throw new ConflictException({ code: 'conflict', message: 'An export of this dock is already in progress' });
    }
    if (live.length >= MAX_LIVE_EXPORTS) throw new TransferLimitException('export_limit_reached', `At most ${MAX_LIVE_EXPORTS} exports can be live at once; they expire after 24 hours`);
    const [row] = await this.db
      .insert(dockExports)
      .values({ organizationId: orgId, dockId: dock.id, createdBy: callerId, image: dock.image, cpus: dock.cpus, memoryMiB: dock.memoryMiB, diskGiB: dock.diskGiB, expiresAt: new Date(now.getTime() + DAY_MS) })
      .returning();
    void this.runExport(row, dock, orgId).catch((err) => this.log.error(`Export ${row.id} crashed: ${(err as Error).message}`));
    return { exportId: row.id };
  }

  /** Captures, rotates the source's gateway tokens, then publishes: a disk copy never becomes downloadable while its tokens are live. */
  async runExport(row: DockExport, dock: Dock, orgId: string): Promise<void> {
    let capture: Awaited<ReturnType<ComputeProvider['captureDisk']>>;
    let held: DockTokens;
    try {
      held = await this.tokensOf(dock.id);
      capture = await this.provider.captureDisk(dock);
    } catch (err) {
      this.log.warn(`Export capture of dock ${dock.id} failed: ${(err as Error).message}`);
      await this.failExport(row.id, EXPORT_FAILED);
      return;
    }
    if (!(await this.rotated(dock, orgId, held))) {
      await this.dropGeneration(capture.snapshotId);
      await this.failExport(row.id, EXPORT_FAILED);
      return;
    }
    const refusal = !capture.baseImage ? EXPORT_BASE_UNSUPPORTED : !SHA256_RE.test(capture.sha256) ? EXPORT_FAILED : null;
    if (refusal) {
      await this.dropGeneration(capture.snapshotId);
      await this.failExport(row.id, refusal);
      return;
    }
    const [ready] = await this.db
      .update(dockExports)
      .set({ state: 'ready', sizeBytes: capture.sizeBytes, sha256: capture.sha256, baseImage: capture.baseImage, storeSnapshotId: capture.snapshotId })
      .where(and(eq(dockExports.id, row.id), eq(dockExports.state, 'pending')))
      .returning({ id: dockExports.id });
    // The sweeper gave up on this export while it ran, so its object has no owner.
    if (!ready) await this.dropGeneration(capture.snapshotId);
  }

  /** The credentials the dock's disk holds: gateway token hashes and its dock-scoped API keys. */
  private async tokensOf(dockId: string): Promise<DockTokens> {
    const [row] = await this.db.select({ llm: docks.llmTokenHash, connector: docks.connectorTokenHash }).from(docks).where(eq(docks.id, dockId)).limit(1);
    const keys = await this.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.dockId, dockId));
    return { llm: row?.llm ?? null, connector: row?.connector ?? null, keyIds: keys.map((k) => k.id) };
  }

  /** Re-applies the dock and confirms every credential the capture holds was replaced; apply records its own failures instead of throwing. */
  private async rotated(dock: Dock, orgId: string, held: DockTokens): Promise<boolean> {
    if (!held.llm && !held.connector && !held.keyIds.length) return true;
    try {
      await this.docks.reapply(dock, orgId);
      const now = await this.tokensOf(dock.id);
      const replaced = (!held.llm || now.llm !== held.llm) && (!held.connector || now.connector !== held.connector) && !held.keyIds.some((id) => now.keyIds.includes(id));
      if (!replaced) this.log.warn(`Export of dock ${dock.id} refused: its credentials did not rotate`);
      return replaced;
    } catch (err) {
      this.log.warn(`Could not rotate the credentials of dock ${dock.id}: ${(err as Error).message}`);
      return false;
    }
  }

  private async failExport(id: string, error: string): Promise<void> {
    await this.db.update(dockExports).set({ state: 'failed', error }).where(and(eq(dockExports.id, id), eq(dockExports.state, 'pending')));
  }

  private async dropGeneration(id: string): Promise<void> {
    await this.provider.deleteBacking(id).catch((err) => this.log.warn(`Could not remove generation ${id}: ${(err as Error).message}`));
  }

  async getExport(callerId: string, exportId: string): Promise<ExportView> {
    const row = await this.loadExport(callerId, exportId);
    const view: ExportView = {
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
      image: row.image,
      cpus: row.cpus,
      memoryMiB: row.memoryMiB,
      diskGiB: row.diskGiB,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      baseImage: row.baseImage,
      url: null,
      expiresAt: row.expiresAt,
      urlExpiresAt: null,
    };
    if (row.state !== 'ready' || !row.storeSnapshotId) return view;
    const signed = await this.objects.presignObject(row.storeSnapshotId, DISK_OBJECT, 'get');
    if (signed.mode === 'direct') return { ...view, url: signed.url, urlExpiresAt: new Date(Date.now() + signed.expiresInSeconds * 1000) };
    // No host-reachable store address: the download goes through the control plane.
    return { ...view, url: exportDownloadPath(row.id), urlExpiresAt: row.expiresAt };
  }

  /** Streams a ready export through the control plane, honoring one byte range so a download can resume. */
  async openDownload(callerId: string, exportId: string, range?: string): Promise<DownloadHandle> {
    const row = await this.loadExport(callerId, exportId);
    if (row.state !== 'ready' || !row.storeSnapshotId) throw new ConflictException({ code: 'conflict', message: 'Export is not ready' });
    const size = row.sizeBytes ?? (await this.objects.objectSize(row.storeSnapshotId, DISK_OBJECT)) ?? 0;
    const parsed = parseRange(range, size);
    if (parsed === 'unsatisfiable') throw validationError('Range is not satisfiable');
    if (!parsed) {
      const { stream } = await this.objects.getObject(row.storeSnapshotId, DISK_OBJECT);
      return { stream, size, start: 0, end: size - 1, partial: false };
    }
    const stream = await this.objects.getObjectRange(row.storeSnapshotId, DISK_OBJECT, parsed.start, parsed.end - parsed.start + 1);
    return { stream, size, start: parsed.start, end: parsed.end, partial: true };
  }

  /** Reads need what opening the source dock needs; a deleted source leaves the exporter and admins. */
  private async loadExport(callerId: string, exportId: string): Promise<DockExport> {
    if (!UUID_RE.test(exportId)) throw new ExportNotFoundException();
    const [row] = await this.db.select().from(dockExports).where(eq(dockExports.id, exportId)).limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) throw new ExportNotFoundException();
    const [source] = await this.db.select({ id: docks.id }).from(docks).innerJoin(workspaces, eq(workspaces.id, docks.workspaceId)).where(eq(docks.id, row.dockId)).limit(1);
    try {
      if (source) {
        await this.docks.loadReadableDock(callerId, row.dockId);
      } else {
        const member = await this.orgs.requireMembership(row.organizationId, callerId);
        if (row.createdBy !== callerId && member.role === 'member') throw new ExportNotFoundException();
      }
    } catch (err) {
      // The role rules (connectors, admins-only secrets) answer 403 as they do on the dock itself.
      if (err instanceof ForbiddenException) throw err;
      throw new ExportNotFoundException();
    }
    return row;
  }

  // Expiry

  /** Removes expired exports and abandoned uploads together with their objects. */
  async sweep(): Promise<{ imports: number; exports: number; interrupted: number }> {
    const now = new Date();
    const interrupted = await this.failStalePending(now);
    const exports = await this.sweepExports(now);
    const imports = await this.sweepImports(now);
    return { imports, exports, interrupted };
  }

  private async failStalePending(now: Date): Promise<number> {
    const limit = deadlineFromConfig('snapshot.create', (key) => process.env[key]) + STALE_MARGIN_MS;
    const stale = await this.db
      .update(dockExports)
      .set({ state: 'failed', error: EXPORT_INTERRUPTED })
      .where(and(eq(dockExports.state, 'pending'), lt(dockExports.createdAt, new Date(now.getTime() - limit))))
      .returning({ id: dockExports.id });
    return stale.length;
  }

  private async sweepExports(now: Date): Promise<number> {
    const rows = await this.db.select().from(dockExports).where(lt(dockExports.expiresAt, now)).limit(SWEEP_BATCH);
    let removed = 0;
    for (const row of rows) {
      try {
        if (row.storeSnapshotId) await this.provider.deleteBacking(row.storeSnapshotId);
        await this.db.delete(dockExports).where(eq(dockExports.id, row.id));
        removed += 1;
      } catch (err) {
        this.log.warn(`Could not remove expired export ${row.id}: ${(err as Error).message}`);
      }
    }
    return removed;
  }

  private async sweepImports(now: Date): Promise<number> {
    const stuck = new Date(now.getTime() - STALE_COMPLETING_MS);
    const rows = await this.db
      .select()
      .from(dockImports)
      .where(and(lt(dockImports.expiresAt, now), or(inArray(dockImports.status, ['uploading', 'uploaded', 'failed', 'completed']), lt(dockImports.updatedAt, stuck))))
      .limit(SWEEP_BATCH);
    let removed = 0;
    for (const row of rows) {
      try {
        // Once a dock was created its snapshot row owns the generation, even when that dock's boot failed.
        if (!row.dockId) await this.discardUpload(row);
        await this.db.delete(dockImports).where(eq(dockImports.id, row.id));
        removed += 1;
      } catch (err) {
        this.log.warn(`Could not remove expired import ${row.id}: ${(err as Error).message}`);
      }
    }
    return removed;
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

function partTooLarge(partSize: number): BadRequestException {
  return new BadRequestException({ code: 'part_too_large', message: `A part is at most ${partSize} bytes` });
}

function errorCode(err: unknown): string | undefined {
  return (err as { response?: { code?: string } }).response?.code;
}

/** Parts must be exactly 1..count once each, with an etag. */
function checkedParts(parts: Array<{ number: number; etag: string }>, count: number): Array<{ number: number; etag: string }> {
  const sorted = [...parts].sort((a, b) => a.number - b.number);
  if (sorted.length !== count || sorted.some((part, index) => part.number !== index + 1 || !part.etag.trim())) {
    throw validationError(`parts must list every part number 1..${count} exactly once with its etag`);
  }
  return sorted;
}
