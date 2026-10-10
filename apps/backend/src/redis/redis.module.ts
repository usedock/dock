import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = 'REDIS';

/** Global Redis client. Connectivity is reported via readiness, not boot. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
        });
        // Prevent unhandled 'error' crashes; readiness tells the truth.
        redis.on('error', (err: Error) => {
          new Logger('RedisModule').warn(`Redis error: ${err.message}`);
        });
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
