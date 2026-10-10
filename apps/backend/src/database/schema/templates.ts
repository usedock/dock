import { bigint, index, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import type { Runtime } from './docks';

export const TEMPLATE_STATUSES = ['saving', 'ready', 'failed'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Frozen named state. Independent of its source dock; hard-deleted with an operation. */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    sourceDockId: uuid('source_dock_id'),
    status: text('status').notNull().$type<TemplateStatus>().default('saving'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    snapshotRef: text('snapshot_ref'),
    /** Generation this template captured and therefore owns. Empty when the
     * template only references a snapshot's generation, which the snapshot's
     * own delete path owns; deleting someone else's generation would corrupt
     * that snapshot, so only this column is ever cleaned up here. */
    storeSnapshotId: text('store_snapshot_id'),
    /** Placement constraints of the owned generation; null when it has none. */
    cpuFamily: text('cpu_family'),
    runtime: text('runtime').$type<Runtime>(),
    baseFingerprint: text('base_fingerprint'),
    /** Set while a capture is in flight; a stale value marks an abandoned save. */
    savingSince: timestamp('saving_since', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('templates_organization_id_name_unique').on(table.organizationId, table.name),
    index('templates_organization_id_idx').on(table.organizationId),
  ],
);

export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
