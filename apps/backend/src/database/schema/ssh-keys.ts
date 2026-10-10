import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/** User SSH public keys accepted by the SSH gateway. */
export const sshKeys = pgTable(
  'ssh_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Canonical `<algo> <base64>` line, comment stripped. */
    publicKey: text('public_key').notNull(),
    /** OpenSSH-style `SHA256:<base64>` of the key blob. */
    fingerprint: text('fingerprint').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ssh_keys_user_id_idx').on(table.userId),
    index('ssh_keys_fingerprint_idx').on(table.fingerprint),
    unique('ssh_keys_user_fingerprint_unique').on(table.userId, table.fingerprint),
  ],
);

export type SshKey = typeof sshKeys.$inferSelect;
