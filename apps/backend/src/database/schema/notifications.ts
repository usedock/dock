import { boolean, index, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

export const NOTIFICATION_ALERT_TYPES = [
  'stopped_responding',
  'stop_refused',
  'disk_warning',
  'disk_full',
  'auto_recovered',
  'held_after_loss',
] as const;
export type NotificationAlertType = (typeof NOTIFICATION_ALERT_TYPES)[number];

/** Billing-class reaches owners/admins only; dock-class reaches workspace members. */
export const NOTIFICATION_AUDIENCE: Record<NotificationAlertType, 'billing' | 'dock'> = {
  stopped_responding: 'dock',
  stop_refused: 'dock',
  disk_warning: 'dock',
  disk_full: 'dock',
  auto_recovered: 'dock',
  held_after_loss: 'dock',
};

/** One row per firing; dock/workspace ids stay plain so deleted-dock history survives. */
export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull().$type<NotificationAlertType>(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id'),
    dockId: uuid('dock_id'),
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    linkPath: text('link_path').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('notification_events_org_idx').on(table.organizationId)],
);

/** Per-user inbox projection; read state is personal even for shared events. */
export const notificationInbox = pgTable(
  'notification_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => notificationEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('notification_inbox_event_id_user_id_unique').on(table.eventId, table.userId),
    index('notification_inbox_user_idx').on(table.userId),
  ],
);

/** Edge-trigger state: one live row per armed crossing; re-arm deletes it, history stays. */
export const notificationEdges = pgTable(
  'notification_edges',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    edgeKey: text('edge_key').notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.edgeKey] })],
);

/** Org enable switch per type. Absent row means enabled. */
export const notificationOrgPrefs = pgTable(
  'notification_org_prefs',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull().$type<NotificationAlertType>(),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.alertType] })],
);

/** Personal email switch per type. Absent row means email on; inbox always delivers. */
export const notificationUserPrefs = pgTable(
  'notification_user_prefs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull().$type<NotificationAlertType>(),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.alertType] })],
);

export type NotificationEvent = typeof notificationEvents.$inferSelect;
export type NewNotificationEvent = typeof notificationEvents.$inferInsert;
export type NotificationInboxRow = typeof notificationInbox.$inferSelect;
