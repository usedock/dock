import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseUrl } from './src/config/database-url';

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveDatabaseUrl({
      nodeEnv: process.env.NODE_ENV,
      databaseUrl: process.env.DATABASE_URL ?? '',
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
    }),
  },
});
