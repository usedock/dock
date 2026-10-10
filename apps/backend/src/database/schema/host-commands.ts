import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const HOST_COMMAND_STATES = ['queued', 'claimed', 'done', 'failed'] as const;
export type HostCommandState = (typeof HOST_COMMAND_STATES)[number];

/**
 * Outbound control channel: the control plane queues a host operation, the
 * docklet long-polls for it and posts the result. Hosts never listen for
 * inbound traffic, so a sandbox machine needs no public port.
 *
 * `idempotencyToken` carries the workflow's token, and the unique index makes
 * a retried enqueue attach to the existing command instead of running twice.
 */
export const hostCommands = pgTable(
  'host_commands',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id').notNull(),
    op: text('op').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    idempotencyToken: text('idempotency_token').notNull(),
    /** Milliseconds the host has to post a result before the awaiter gives up. */
    deadlineMs: integer('deadline_ms').notNull(),
    state: text('state').notNull().$type<HostCommandState>().default('queued'),
    result: jsonb('result').$type<unknown>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    // Poll path: next queued command for one host, oldest first.
    index('host_commands_poll_idx').on(table.hostId, table.state, table.createdAt),
    // Sweep path: expire queued and delete finished rows across hosts.
    index('host_commands_state_created_idx').on(table.state, table.createdAt),
    uniqueIndex('host_commands_dedupe_idx').on(table.hostId, table.idempotencyToken),
  ],
);

export type HostCommand = typeof hostCommands.$inferSelect;
export type NewHostCommand = typeof hostCommands.$inferInsert;

/**
 * Binds a new generation id to the first host and snapshot.create command that
 * wrote it, so no other host (and no later command) can write or delete it.
 */
export const hostGenerations = pgTable(
  'host_generations',
  {
    generationId: text('generation_id').primaryKey(),
    hostId: text('host_id').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('host_generations_command_idx').on(table.commandId)],
);

export type HostGeneration = typeof hostGenerations.$inferSelect;
