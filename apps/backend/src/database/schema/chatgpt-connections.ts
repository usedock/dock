import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { SealedValue } from './environments';
import { users } from './users';

export type ChatgptConnectionStatus = 'active' | 'expired';

/** One personal ChatGPT subscription sign-in per user; tokens sealed, never shared with the org. */
export const chatgptConnections = pgTable('chatgpt_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id'),
  email: text('email'),
  planType: text('plan_type'),
  status: text('status').notNull().$type<ChatgptConnectionStatus>().default('active'),
  /** Sealed JSON `{ access, refresh }`. */
  secret: jsonb('secret').notNull().$type<SealedValue>(),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ChatgptConnection = typeof chatgptConnections.$inferSelect;
