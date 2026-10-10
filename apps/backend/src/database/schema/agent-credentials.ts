import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { SealedValue } from './environments';
import { organizations } from './organizations';

export const PROVIDER_NAMES = ['anthropic', 'openai', 'openrouter', 'opencode'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Provider env vars each stored key fills; platform fills only unset vars. */
export const PROVIDER_ENV_VARS: Record<ProviderName, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  // One OpenCode console key serves both Zen and Go.
  opencode: ['OPENCODE_API_KEY'],
};

/** Org-scoped provider API keys, AES-256-GCM sealed; values never leave sealed form except injection and reveal. */
export const providerKeys = pgTable(
  'provider_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    secret: jsonb('secret').notNull().$type<SealedValue>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('provider_keys_organization_id_provider_unique').on(table.organizationId, table.provider),
    index('provider_keys_organization_id_idx').on(table.organizationId),
  ],
);

export type ProviderKey = typeof providerKeys.$inferSelect;
