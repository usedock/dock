import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Runtime } from './docks';

export const HOST_STATES = ['online', 'offline'] as const;
export type HostState = (typeof HOST_STATES)[number];

/** One runtime a host reports in its heartbeat; mirrored into the registry. */
export interface HostWorkload {
  dockId: string;
  state: string;
  kind?: string;
}

/** Bare-metal host fleet; heartbeats refresh capacity, sweeps mark the silent offline. */
export const hosts = pgTable(
  'hosts',
  {
    id: text('id').primaryKey(),
    /** Last address the host connected from; informational only, never dialed. */
    address: text('address').notNull(),
    cpuFamily: text('cpu_family').notNull(),
    kernel: text('kernel').notNull(),
    runtime: text('runtime').notNull().$type<Runtime>().default('microvm'),
    kernelRelease: text('kernel_release'),
    vcpuTotal: integer('vcpu_total').notNull().default(0),
    // Byte counts exceed a 32-bit integer on any real host, so they are bigint.
    memTotalBytes: bigint('mem_total_bytes', { mode: 'number' }).notNull().default(0),
    /** Memory the host lets guests commit after its own reserve; null falls back to memTotalBytes. */
    memBudgetBytes: bigint('mem_budget_bytes', { mode: 'number' }),
    diskTotalBytes: bigint('disk_total_bytes', { mode: 'number' }).notNull().default(0),
    maxDocks: integer('max_docks').notNull(),
    usedDocks: integer('used_docks').notNull().default(0),
    /** Last reported runtime inventory; the reconciler's source of truth. */
    running: jsonb('running').notNull().$type<HostWorkload[]>().default([]),
    /** Base image fingerprints the host holds; null until a docklet reports them (unknown, not none). */
    baseFingerprints: jsonb('base_fingerprints').$type<string[]>(),
    /** SHA-256 of the per-host fleet credential; null until the host (re)registers with the enrollment token. */
    credentialHash: text('credential_hash'),
    state: text('state').notNull().$type<HostState>().default('online'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('hosts_state_idx').on(table.state), uniqueIndex('hosts_credential_hash_idx').on(table.credentialHash)],
);

export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
