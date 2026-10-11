import { bigint, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const DOCK_IMPORT_STATUSES = ['uploading', 'completing', 'uploaded', 'completed', 'failed'] as const;
export type DockImportStatus = (typeof DOCK_IMPORT_STATUSES)[number];

export const DOCK_EXPORT_STATES = ['pending', 'ready', 'failed'] as const;
export type DockExportState = (typeof DOCK_EXPORT_STATES)[number];

/**
 * One uploaded disk on its way to becoming a dock. Org and workspace ids are
 * plain columns, not foreign keys: the sweeper must still find the upload and
 * its objects after the workspace is gone.
 */
export const dockImports = pgTable(
  'dock_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    name: varchar('name', { length: 100 }),
    image: text('image').notNull(),
    cpus: integer('cpus').notNull(),
    memoryMiB: integer('memory_mib').notNull(),
    diskGiB: integer('disk_gib').notNull(),
    /** Declared size and sha256 of the compressed rootfs.ext4.zst. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    /** Store generation the upload becomes; owned by the import until a snapshot row takes it over. */
    storeSnapshotId: text('store_snapshot_id').notNull(),
    uploadId: text('upload_id').notNull(),
    mode: text('mode').notNull().$type<'direct' | 'proxy'>(),
    partSize: bigint('part_size', { mode: 'number' }).notNull(),
    partCount: integer('part_count').notNull(),
    status: text('status').notNull().$type<DockImportStatus>().default('uploading'),
    error: text('error'),
    dockId: uuid('dock_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('dock_imports_expires_at_idx').on(table.expiresAt), index('dock_imports_organization_id_idx').on(table.organizationId)],
);

/** A dock's disk captured for download; the objects live until `expiresAt`. */
export const dockExports = pgTable(
  'dock_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    dockId: uuid('dock_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    state: text('state').notNull().$type<DockExportState>().default('pending'),
    error: text('error'),
    image: text('image').notNull(),
    cpus: integer('cpus').notNull(),
    memoryMiB: integer('memory_mib').notNull(),
    diskGiB: integer('disk_gib').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    /** Space the flattened disk's data takes decompressed and written sparse, so a pull sizes its free-space check; null for exports whose host did not report it. */
    dataBytes: bigint('data_bytes', { mode: 'number' }),
    baseImage: text('base_image'),
    storeSnapshotId: text('store_snapshot_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('dock_exports_expires_at_idx').on(table.expiresAt), index('dock_exports_dock_id_idx').on(table.dockId)],
);

export type DockImport = typeof dockImports.$inferSelect;
export type DockExport = typeof dockExports.$inferSelect;
