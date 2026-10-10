export interface DatabaseUrlInput {
  nodeEnv?: string;
  databaseUrl: string;
  testDatabaseUrl?: string;
}

/**
 * Selects the Postgres URL by environment. Test selection without a test
 * URL throws: falling back to the shared database would risk test writes
 * landing in dev or prod data.
 */
export function resolveDatabaseUrl(input: DatabaseUrlInput): string {
  if (input.nodeEnv !== 'test') return input.databaseUrl;
  if (!input.testDatabaseUrl) {
    throw new Error('TEST_DATABASE_URL is required when NODE_ENV=test');
  }
  return input.testDatabaseUrl;
}
