import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';
import { resolveDatabaseUrl } from '../config/database-url';

export const PG_POOL = 'PG_POOL';
export const DB = 'DB';

export type Db = NodePgDatabase<typeof schema>;

/** Global Postgres pool + schema-typed Drizzle client. */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: resolveDatabaseUrl({
            nodeEnv: process.env.NODE_ENV,
            databaseUrl: config.getOrThrow<string>('DATABASE_URL'),
            testDatabaseUrl: config.get<string>('TEST_DATABASE_URL'),
          }),
          max: 10,
        });
        // Idle-client errors (e.g. DB restart) must not crash the process;
        // readiness reports connectivity instead.
        pool.on('error', (err: Error) => {
          new Logger('DatabaseModule').warn(`Idle pool client error: ${err.message}`);
        });
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Db => drizzle(pool, { schema }),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DatabaseModule {}
