import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const ENV_PROVIDERS = ['github', 'gitlab'] as const;
export type EnvProvider = (typeof ENV_PROVIDERS)[number];

export const SECRETS_ACCESS = ['members', 'admins'] as const;
export type SecretsAccess = (typeof SECRETS_ACCESS)[number];

/** Environment names: 2-64 chars, lowercase/digits/dash/underscore, padded ends. */
export const ENV_NAME_RE = /^[a-z0-9]([a-z0-9-_]{0,62}[a-z0-9])$/;

/** One cloned repository selection inside an environment version. */
export interface EnvRepo {
  id: string;
  provider: EnvProvider;
  repositoryId: string;
  fullName: string;
  baseBranch: string | null;
  setupScript: string | null;
}

/** AES-256-GCM sealed value; base64 fields, decrypted only on reveal or dock start. */
export interface SealedValue {
  iv: string;
  tag: string;
  data: string;
}

/** One secret file inside an environment version; contents stay sealed in reads. */
export interface EnvSecretFile {
  path: string;
  size: number;
  contents: SealedValue;
}

/** Named policy bundle pointer; content lives in immutable version rows. */
export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    currentVersion: integer('current_version').notNull().default(1),
    secretsAccess: text('secrets_access', { enum: SECRETS_ACCESS }).notNull().default('admins'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('environments_organization_id_name_unique').on(table.organizationId, table.name),
    index('environments_organization_id_idx').on(table.organizationId),
  ],
);

/** Immutable content snapshot; docks pin one version number for life. */
export const environmentVersions = pgTable(
  'environment_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    safeForThirdParties: boolean('safe_for_third_parties').notNull().default(false),
    passGithub: boolean('pass_github').notNull().default(true),
    passSecrets: boolean('pass_secrets').notNull().default(true),
    passDockCredentials: boolean('pass_dock_credentials').notNull().default(false),
    passAgentsCredentials: boolean('pass_agents_credentials').notNull().default(true),
    repos: jsonb('repos').notNull().$type<EnvRepo[]>(),
    envVars: jsonb('env_vars').notNull().$type<Record<string, SealedValue>>(),
    secretFiles: jsonb('secret_files').notNull().$type<EnvSecretFile[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('environment_versions_environment_id_version_unique').on(table.environmentId, table.version),
    index('environment_versions_environment_id_idx').on(table.environmentId),
  ],
);

export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;
export type EnvironmentVersion = typeof environmentVersions.$inferSelect;
export type NewEnvironmentVersion = typeof environmentVersions.$inferInsert;
