import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';
import { workspaces } from './workspaces';
import type { SealedValue } from './environments';
import type { RunCapabilities } from '../../github/run-capabilities';

export const GITHUB_RUN_STATES = [
  'pending',
  'provisioning',
  'working',
  'pr_opened',
  'failed',
  'stopped',
  'done',
] as const;
export type GithubRunState = (typeof GITHUB_RUN_STATES)[number];

export const GITHUB_DELIVERY_STATUSES = ['received', 'processing', 'succeeded', 'failed'] as const;
export type GithubDeliveryStatus = (typeof GITHUB_DELIVERY_STATUSES)[number];

export const GITHUB_EXECUTION_TARGETS = ['dock', 'fast'] as const;
export type GithubExecutionTarget = (typeof GITHUB_EXECUTION_TARGETS)[number];

export const GITHUB_ARTIFACT_STATUSES = ['pending', 'published', 'failed'] as const;
export type GithubArtifactStatus = (typeof GITHUB_ARTIFACT_STATUSES)[number];

export type GithubRunEnvelope = { issue: string; system: string; constraints: string };


/** One GitHub App installation mapped to the workspace it bills and provisions in. */
export const githubInstallations = pgTable(
  'github_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: integer('installation_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    repos: jsonb('repos').notNull().$type<string[]>().default([]),
    agent: text('agent').notNull().default('opencode'),
    testCommand: text('test_command'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('github_installations_workspace_idx').on(table.workspaceId)],
);

/** One @dock mention execution: issue in, at most one PR out, dock stopped after. */
export const githubRuns = pgTable(
  'github_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => githubInstallations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    triggerCommentId: integer('trigger_comment_id').notNull().unique(),
    deliveryGuid: text('delivery_guid').notNull(),
    hookId: text('hook_id').notNull(),
    baseBranch: text('base_branch').notNull().default('main'),
    baseSha: text('base_sha'),
    dockId: uuid('dock_id'),
    executionTarget: text('execution_target').notNull().$type<GithubExecutionTarget>().default('dock'),
    requestedCapabilities: jsonb('requested_capabilities').notNull().$type<RunCapabilities>().default({}),
    resolvedCapabilities: jsonb('resolved_capabilities').$type<RunCapabilities | null>(),
    attemptId: uuid('attempt_id').defaultRandom().notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    runtimeId: text('runtime_id'),
    runtimeHostId: text('runtime_host_id'),
    artifactStatus: text('artifact_status').notNull().$type<GithubArtifactStatus>().default('pending'),
    artifactError: text('artifact_error'),
    state: text('state').notNull().$type<GithubRunState>().default('pending'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    failureReason: text('failure_reason'),
    sealedToken: jsonb('sealed_token').$type<SealedValue | null>(),
    agent: text('agent').notNull().default('opencode'),
    testCommand: text('test_command'),
    promptVersion: text('prompt_version'),
    envelopeHash: text('envelope_hash'),
    envelope: jsonb('envelope').$type<GithubRunEnvelope | null>(),
    instructionFiles: jsonb('instruction_files').notNull().$type<string[]>().default([]),
    branch: text('branch'),
    completionTokenHash: text('completion_token_hash'),
    gatewayTokenHash: text('gateway_token_hash'),
    model: text('model'),
    /** User whose personal ChatGPT sign-in serves `chatgpt/*` models; null uses org provider keys. */
    llmUserId: uuid('llm_user_id').references(() => users.id, { onDelete: 'set null' }),
    completionConsumed: boolean('completion_consumed').notNull().default(false),
    completionStatus: text('completion_status'),
    events: jsonb('events').notNull().$type<{ t: string; at: string }[]>().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('github_runs_repo_issue_idx').on(table.repo, table.issueNumber, table.state),
    index('github_runs_installation_idx').on(table.installationId),
    index('github_runs_gateway_token_idx').on(table.gatewayTokenHash),
  ],
);


/** Durable Fast Run evidence; runtime-local files are deleted after publication. */
export const githubRunArtifacts = pgTable(
  'github_run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => githubRuns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    content: text('content').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('github_run_artifacts_run_name_unique').on(table.runId, table.name),
    index('github_run_artifacts_run_idx').on(table.runId),
  ],
);

/** Inbound delivery claim: (hookId, deliveryGuid) decides redeliveries, never the numeric id. */
export const githubWebhookDeliveries = pgTable(
  'github_webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hookId: text('hook_id').notNull(),
    deliveryGuid: text('delivery_guid').notNull(),
    event: text('event').notNull(),
    status: text('status').notNull().$type<GithubDeliveryStatus>().default('received'),
    runId: uuid('run_id').references(() => githubRuns.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('github_webhook_deliveries_hook_guid_unique').on(table.hookId, table.deliveryGuid)],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
export type GithubRun = typeof githubRuns.$inferSelect;
export type NewGithubRun = typeof githubRuns.$inferInsert;
export type GithubRunArtifact = typeof githubRunArtifacts.$inferSelect;
export type NewGithubRunArtifact = typeof githubRunArtifacts.$inferInsert;
export type GithubWebhookDelivery = typeof githubWebhookDeliveries.$inferSelect;
