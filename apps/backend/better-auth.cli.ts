import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { schema } from './src/database/schema/index';

// Standalone config for `auth migrate` only: creates the session/account/
// verification tables (plus mapped users columns, already in drizzle
// migrations) against DATABASE_URL. Runtime config lives in
// src/auth/better-auth/better-auth.service.ts.
export const auth = betterAuth({
  database: drizzleAdapter(
    drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema }),
    { provider: 'pg' },
  ),
  user: { modelName: 'users' },
  emailAndPassword: { enabled: true },
  advanced: { database: { generateId: () => randomUUID() } },
});
