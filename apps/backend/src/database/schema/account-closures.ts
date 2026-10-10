import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const CLOSURE_STATES = ['closed', 'erased'] as const;
export type ClosureState = (typeof CLOSURE_STATES)[number];

/** Whole-account destructive lifecycle. No row means open. */
export const accountClosures = pgTable('account_closures', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  state: text('state').notNull().$type<ClosureState>(),
  purgeAt: timestamp('purge_at', { withTimezone: true }),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  subscriptionCanceledAt: timestamp('subscription_canceled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AccountClosure = typeof accountClosures.$inferSelect;
export type NewAccountClosure = typeof accountClosures.$inferInsert;
