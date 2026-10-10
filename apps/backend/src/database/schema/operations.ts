import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const OPERATION_TARGETS = ['dock', 'snapshot', 'template', 'environment'] as const;
export type OperationTarget = (typeof OPERATION_TARGETS)[number];

export const OPERATION_STATUSES = ['pending', 'processing', 'blocked', 'completed'] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Pollable receipt for accepted async work. Uncancellable, immutable history. */
export const operations = pgTable(
  'operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayId: text('display_id').notNull().unique(),
    // Owning org gates polls; null rows predate scoping and stay hidden.
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull().$type<OperationTarget>(),
    targetId: text('target_id').notNull(),
    status: text('status').notNull().$type<OperationStatus>().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('operations_status_idx').on(table.status),
    index('operations_organization_idx').on(table.organizationId),
  ],
);

export type Operation = typeof operations.$inferSelect;
export type NewOperation = typeof operations.$inferInsert;
