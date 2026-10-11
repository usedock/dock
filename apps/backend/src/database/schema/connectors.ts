import { boolean, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    /** Vendor account id inbound webhooks are routed by: Linear organization, Slack team, Sentry installation uuid, Figma webhook id. */
    externalId: text('external_id'),
    /** Sealed signing secret (Linear, Slack, Sentry) or passcode (Figma) for this connector's webhooks. */
    webhookSecret: jsonb('webhook_secret').$type<SealedValue>(),
    /** Sentry region or self-hosted origin; null means sentry.io. */
    host: text('host'),
    /** Vendor user id of the connected identity (the Dock app user that triggers match). */
    vendorUserId: text('vendor_user_id'),
    /** Sentry organization slug the connected token read at connect time; replies post under it. */
    vendorOrg: text('vendor_org'),
    /** Figma user ids allowed to start runs; defaults to the connecting admin. */
    allowedUsers: jsonb('allowed_users').notNull().$type<string[]>().default([]),
    /** Sentry events start runs only after an admin opts in. */
    triggersEnabled: boolean('triggers_enabled').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('connectors_workspace_id_kind_unique').on(table.workspaceId, table.kind),
    index('connectors_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('connectors_kind_external_id_unique')
      .on(table.kind, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

export type Connector = typeof connectors.$inferSelect;

export type ConnectorRunState = 'pending' | 'working' | 'succeeded' | 'failed' | 'timed_out';

/** Where a run's result goes back to; shape depends on the kind. */
export interface ConnectorReplyTarget {
  issueId?: string;
  channel?: string;
  threadTs?: string;
  org?: string;
  fileKey?: string;
  commentId?: string;
}

/** Inbound webhook dedupe, like github_webhook_deliveries. */
export const connectorDeliveries = pgTable(
  'connector_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().$type<ConnectorKind>(),
    deliveryId: text('delivery_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('connector_deliveries_kind_delivery_id_unique').on(table.kind, table.deliveryId),
    index('connector_deliveries_received_at_idx').on(table.receivedAt),
  ],
);

/** One agent run started by a connected tool's event, executed in a connector dock. */
export const connectorRuns = pgTable(
  'connector_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<ConnectorKind>(),
    state: text('state').notNull().$type<ConnectorRunState>().default('pending'),
    /** Event-level key (issue, thread, comment) so one subject has one active run. */
    triggerKey: text('trigger_key').notNull(),
    organizationId: uuid('organization_id'),
    agent: text('agent').notNull().default('opencode'),
    model: text('model'),
    /** Hash of the run-scoped LLM gateway token; the plaintext only reaches the dock. */
    gatewayTokenHash: text('gateway_token_hash'),
    reply: jsonb('reply').notNull().$type<ConnectorReplyTarget>(),
    dockId: uuid('dock_id'),
    completionTokenHash: text('completion_token_hash').notNull(),
    summary: text('summary'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('connector_runs_workspace_id_idx').on(table.workspaceId), index('connector_runs_state_idx').on(table.state)],
);

export type ConnectorRun = typeof connectorRuns.$inferSelect;
