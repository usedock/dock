import { boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/** Per-organization retention switch. On: every archive becomes a deletion. */
export const retentionPolicies = pgTable('retention_policies', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  zdrEnabled: boolean('zdr_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RetentionPolicy = typeof retentionPolicies.$inferSelect;
export type NewRetentionPolicy = typeof retentionPolicies.$inferInsert;
