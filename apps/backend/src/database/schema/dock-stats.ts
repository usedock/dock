import { bigint, index, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { docks } from './docks';

/** Per-container enrichment from guest Docker. Absent when Docker is unreachable. */
export interface DockStatContainer {
  name: string;
  cpuPercent: number;
  memBytes: number;
}

/** Host-truth sample: cgroups + TAP counters. Guest numbers stay untrusted. */
export const dockStats = pgTable(
  'dock_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dockId: uuid('dock_id')
      .notNull()
      .references(() => docks.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    cpuPercent: real('cpu_percent').notNull().default(0),
    memBytes: bigint('mem_bytes', { mode: 'number' }).notNull().default(0),
    memLimit: bigint('mem_limit', { mode: 'number' }).notNull().default(0),
    diskBytes: bigint('disk_bytes', { mode: 'number' }).notNull().default(0),
    rxBytes: bigint('rx_bytes', { mode: 'number' }).notNull().default(0),
    txBytes: bigint('tx_bytes', { mode: 'number' }).notNull().default(0),
    containers: jsonb('containers').$type<DockStatContainer[] | null>(),
    source: text('source').notNull().default('host'),
  },
  (table) => [index('dock_stats_dock_id_at_idx').on(table.dockId, table.at)],
);

export type DockStat = typeof dockStats.$inferSelect;
export type NewDockStat = typeof dockStats.$inferInsert;
