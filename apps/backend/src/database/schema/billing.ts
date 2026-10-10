import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';

export const BILLING_PLANS = ['developer', 'builder', 'scale'] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLABLE_STATUSES: SubscriptionStatus[] = ['active', 'trialing'];

export const METERING_UNITS = ['compute', 'storage'] as const;
export type MeteringUnit = (typeof METERING_UNITS)[number];

/** Versioned plan terms. Subscriptions pin a version so repricing never rewrites history. */
export const billingPlans = pgTable(
  'billing_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan: text('plan').notNull().$type<BillingPlan>(),
    version: integer('version').notNull().default(1),
    baseFeeCents: integer('base_fee_cents').notNull(),
    includedUsageCents: integer('included_usage_cents').notNull(),
    concurrencyCap: integer('concurrency_cap').notNull(),
    fastRunConcurrencyCap: integer('fast_run_concurrency_cap').notNull().default(0),
    retentionDays: integer('retention_days').notNull(),
    includedSeats: integer('included_seats').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('billing_plans_plan_version_unique').on(table.plan, table.version),
    index('billing_plans_plan_current_idx').on(table.plan, table.isCurrent),
  ],
);

/** Exactly one subscription per organization; org delete cascades. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().$type<BillingPlan>().default('developer'),
    planVersion: integer('plan_version').notNull().default(1),
    status: text('status').notNull().$type<SubscriptionStatus>().default('active'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    pendingPlan: text('pending_plan').$type<BillingPlan>(),
    pendingPlanVersion: integer('pending_plan_version'),
    /** Provider `created` of the last applied webhook event; older events are ignored. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('subscriptions_status_idx').on(table.status),
    uniqueIndex('subscriptions_provider_customer_idx')
      .on(table.providerCustomerId)
      .where(sql`${table.providerCustomerId} IS NOT NULL`),
  ],
);

/** Billable activity window. Seconds derive from opened/closed at aggregation time. */
export const meteringWindows = pgTable(
  'metering_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id'),
    dockId: uuid('dock_id'),
    runtimeId: text('runtime_id'),
    unit: text('unit').notNull().$type<MeteringUnit>(),
    executionTarget: text('execution_target').notNull().default('dock'),
    cpus: integer('cpus').notNull().default(2),
    memoryMiB: integer('memory_mib').notNull().default(4096),
    diskGiB: integer('disk_gib').notNull().default(20),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('metering_windows_org_opened_idx').on(table.organizationId, table.openedAt),
    index('metering_windows_dock_idx').on(table.dockId),
    index('metering_windows_runtime_idx').on(table.runtimeId),
    uniqueIndex('metering_windows_open_dock_idx').on(table.dockId).where(sql`${table.closedAt} IS NULL AND ${table.dockId} IS NOT NULL`),
  ],
);

export type BillingPlanRow = typeof billingPlans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type MeteringWindow = typeof meteringWindows.$inferSelect;
