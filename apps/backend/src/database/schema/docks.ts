import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { DOCKYARD_IMAGE_NAMES } from '../../images/catalog';
import { users } from './users';
import { workspaces } from './workspaces';

export const RUNTIMES = ['microvm', 'gvisor'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_MIB = 4096;
export const DEFAULT_DISK_GIB = 20;
export const DEFAULT_IMAGE = 'ubuntu-24.04';
export const DOCK_IMAGES: readonly string[] = DOCKYARD_IMAGE_NAMES;

/** Paths that survive stop and resume: the whole disk on a microVM, only the work dir on gVisor. */
export const PERSISTENT_PATHS: Record<Runtime, string[]> = { microvm: ['/'], gvisor: ['/home/user/work'] };

/** Dock states whose machine holds floors on its host; archived and error docks hold none. */
export const CAPACITY_HOLDING_STATES: readonly DockState[] = ['provisioning', 'provisioned', 'cloning', 'ready', 'idle', 'running', 'archiving', 'unreachable'];

export const DOCK_STATES = [
  'provisioning',
  'provisioned',
  'cloning',
  'ready',
  'idle',
  'running',
  'archiving',
  'archived',
  'error',
  'unreachable',
] as const;
export type DockState = (typeof DOCK_STATES)[number];

export const SETUP_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/** Persistent machine. Deleted rows are gone: reads 404, only operations remain. */
export const docks = pgTable(
  'docks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Unique per workspace when set. */
    name: varchar('name', { length: 100 }),
    cpus: integer('cpus').notNull().default(DEFAULT_CPUS),
    memoryMiB: integer('memory_mib').notNull().default(DEFAULT_MEMORY_MIB),
    diskGiB: integer('disk_gib').notNull().default(DEFAULT_DISK_GIB),
    image: text('image').notNull().default(DEFAULT_IMAGE),
    /** Runtime of the host the dock was placed on. */
    runtime: text('runtime').notNull().$type<Runtime>().default('microvm'),
    state: text('state').notNull().$type<DockState>().default('provisioning'),
    ttlSeconds: integer('ttl_seconds'),
    environment: text('environment').notNull().default('base'),
    envVersionPin: text('env_version_pin'),
    noEnv: boolean('no_env').notNull().default(false),
    /** When the dock was last pointed at its environment (create, branch, resume onto another); null on legacy rows means createdAt. */
    envBoundAt: timestamp('env_bound_at', { withTimezone: true }),
    env: jsonb('env').notNull().$type<Record<string, string>>(),
    fromTemplate: text('from_template'),
    ip: text('ip'),
    hostId: text('host_id'),
    /** Who created the dock; its dock API credential acts as this user. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** SHA-256 of the dock-scoped LLM gateway token; set only while the creator's ChatGPT sign-in serves the dock. */
    llmTokenHash: text('llm_token_hash'),
    /** Connector kinds the dock was created with; the gateway serves only these. */
    connectors: jsonb('connectors').notNull().$type<string[]>().default([]),
    /** SHA-256 of the dock-scoped connector gateway token; rotated on every apply, gone with the dock. */
    connectorTokenHash: text('connector_token_hash'),
    setupStatus: text('setup_status').notNull().$type<SetupStatus>().default('pending'),
    setupError: text('setup_error'),
    lastSnapshotAt: timestamp('last_snapshot_at', { withTimezone: true }),
    diskBytes: bigint('disk_bytes', { mode: 'number' }).notNull().default(0),
    /** Set when the machine last became ready; null while a boot is unconfirmed, so a failed boot is fenced rather than revived. */
    liveSince: timestamp('live_since', { withTimezone: true }),
    billingPausedAt: timestamp('billing_paused_at', { withTimezone: true }),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('docks_workspace_id_state_idx').on(table.workspaceId, table.state),
    index('docks_state_idx').on(table.state),
    index('docks_llm_token_idx').on(table.llmTokenHash),
    index('docks_connector_token_idx').on(table.connectorTokenHash),
    uniqueIndex('docks_workspace_id_name_unique').on(table.workspaceId, table.name).where(sql`${table.name} IS NOT NULL`),
  ],
);

export type Dock = typeof docks.$inferSelect;
export type NewDock = typeof docks.$inferInsert;
