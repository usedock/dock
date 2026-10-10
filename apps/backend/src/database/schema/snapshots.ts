import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { docks, type Runtime } from './docks';

export const SNAPSHOT_STATUSES = ['saving', 'completed', 'failed'] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

/** One marker file inside a snapshot manifest. Fake-driver content is tiny. */
export interface SnapshotFileEntry {
  path: string;
  size: number;
  content: string;
}

export interface SnapshotManifest {
  files: SnapshotFileEntry[];
}

/** Point-in-time filesystem capture. Deleted rows are gone; chains checked in service. */
export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dockId: uuid('dock_id')
      .notNull()
      .references(() => docks.id, { onDelete: 'cascade' }),
    status: text('status').notNull().$type<SnapshotStatus>().default('completed'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    parentId: uuid('parent_id'),
    manifest: jsonb('manifest').notNull().$type<SnapshotManifest>(),
    storeSnapshotId: text('store_snapshot_id'),
    cpuFamily: text('cpu_family'),
    runtime: text('runtime').$type<Runtime>(),
    kernelRelease: text('kernel_release'),
    /** Base image a microVM delta generation restores onto; null for gVisor and whole-image generations. */
    baseFingerprint: text('base_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('snapshots_dock_id_idx').on(table.dockId),
    index('snapshots_dock_id_created_at_idx').on(table.dockId, table.createdAt),
  ],
);

export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
