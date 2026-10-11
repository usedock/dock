import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { SealedValue } from './environments';
import { users } from './users';
import { workspaces } from './workspaces';

export const CONNECTOR_KINDS = ['figma', 'linear', 'slack', 'sentry'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export type ConnectorStatus = 'connected' | 'reauth_required';

/** Workspace-scoped tool connection; the credential is AES-256-GCM sealed and only the gateway opens it. */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<ConnectorKind>(),
    status: text('status').notNull().$type<ConnectorStatus>().default('connected'),
    credentials: jsonb('credentials').notNull().$type<SealedValue>(),
    accountLabel: text('account_label'),
    scopes: jsonb('scopes').notNull().$type<string[]>().default([]),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('connectors_workspace_id_kind_unique').on(table.workspaceId, table.kind),
    index('connectors_workspace_id_idx').on(table.workspaceId),
  ],
);

export type Connector = typeof connectors.$inferSelect;
