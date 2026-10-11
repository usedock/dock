import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { docks } from './docks';

/** Dock ports exposed at `https://<label>.<PORTS_DOMAIN>`; the random label is the capability. */
export const dockPorts = pgTable(
  'dock_ports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dockId: uuid('dock_id')
      .notNull()
      .references(() => docks.id, { onDelete: 'cascade' }),
    port: integer('port').notNull(),
    /** `public`: anyone with the URL; `private`: org members and dock-bound keys only. */
    visibility: text('visibility', { enum: ['public', 'private'] }).notNull().default('public'),
    label: text('label').notNull().unique('dock_ports_label_unique'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('dock_ports_dock_port_unique').on(table.dockId, table.port)],
);

export type DockPort = typeof dockPorts.$inferSelect;
