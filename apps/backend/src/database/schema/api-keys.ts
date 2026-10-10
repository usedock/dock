import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { docks } from './docks';
import { users } from './users';

/** Long-lived user API keys. Only SHA-256 hashes stored; raw shown once. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Set for a dock's injected credential: hidden from key lists, gone with the dock. */
    dockId: uuid('dock_id').references(() => docks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_keys_user_id_idx').on(table.userId),
    index('api_keys_key_hash_idx').on(table.keyHash),
    index('api_keys_dock_id_idx').on(table.dockId),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
