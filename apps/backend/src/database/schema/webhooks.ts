import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import type { SealedValue } from './environments';

export const WEBHOOK_EVENT_TYPES = ['dock.ready', 'dock.error', 'dock.archived', 'dock.hydrated'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Outbound endpoint subscription. Secret stays sealed; raw value shown once at create. */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    url: text('url').notNull(),
    events: jsonb('events').notNull().$type<WebhookEventType[]>(),
    secret: jsonb('secret').notNull().$type<SealedValue>(),
    secretPrefix: varchar('secret_prefix', { length: 8 }).notNull(),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('webhook_endpoints_org_idx').on(table.organizationId)],
);

/** Outbound event outbox. Stable ids let receivers dedupe redeliveries. */
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull().$type<WebhookEventType>(),
  dockId: uuid('dock_id').notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id'),
  state: text('state').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const DELIVERY_STATUSES = ['pending', 'sent', 'gave_up'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** One delivery per event per endpoint; the dispatcher owns pending rows. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    status: text('status').notNull().$type<DeliveryStatus>().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('webhook_deliveries_event_id_endpoint_id_unique').on(table.eventId, table.endpointId),
    index('webhook_deliveries_due_idx').on(table.status, table.nextAttemptAt),
  ],
);

/** One delivery attempt per event per endpoint; append-only for inspection. */
export const webhookAttempts = pgTable(
  'webhook_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    status: integer('status'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('webhook_attempts_event_idx').on(table.eventId),
    index('webhook_attempts_endpoint_idx').on(table.endpointId),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type WebhookAttempt = typeof webhookAttempts.$inferSelect;
