import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { connectorRuns, type ConnectorKind } from './connectors';
import { users } from './users';
import { workspaces } from './workspaces';

/** Scope key that matches every subject of a connector. */
export const REPO_LINK_ANY_SCOPE = '*';

/**
 * An admin's mapping from one connector scope (Linear team id, Slack channel id, Sentry project slug,
 * Figma file key, or `*`) to a GitHub repository a GitHub App installation of the workspace can reach.
 * Triggered runs on a matching subject get a run-scoped token for that one repository and may open a pull request.
 */
export const connectorRepoLinks = pgTable(
  'connector_repo_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<ConnectorKind>(),
    scope: text('scope').notNull(),
    /** `owner/repo`. */
    repo: text('repo').notNull(),
    /** GitHub App installation that reached the repo at link time. */
    installationId: integer('installation_id').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('connector_repo_links_workspace_kind_scope_unique').on(table.workspaceId, table.kind, table.scope)],
);

export type ConnectorRepoLink = typeof connectorRepoLinks.$inferSelect;

/** What a linked run was started against, fixed when the run starts; the pull request is opened from it at completion. */
export const connectorRunRepos = pgTable(
  'connector_run_repos',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => connectorRuns.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    installationId: integer('installation_id').notNull(),
    baseBranch: text('base_branch').notNull(),
    baseSha: text('base_sha').notNull(),
    branch: text('branch').notNull(),
    /** Subject title and link for the pull request; sanitized when stored. */
    title: text('title').notNull(),
    subjectUrl: text('subject_url'),
    prUrl: text('pr_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('connector_run_repos_workspace_id_idx').on(table.workspaceId)],
);

export type ConnectorRunRepo = typeof connectorRunRepos.$inferSelect;
