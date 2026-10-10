import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

export type DependencyStatus = 'up' | 'down';

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>(
      (_, reject) =>
        (timer = setTimeout(() => reject(new Error('dependency timeout')), ms)),
    );
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async checks(): Promise<{ postgres: DependencyStatus; redis: DependencyStatus }> {
    const [postgres, redis] = await Promise.all([this.pgOk(), this.redisOk()]);
    return { postgres, redis };
  }

  private async pgOk(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.pool.query('SELECT 1'), 2000);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async redisOk(): Promise<DependencyStatus> {
    try {
      const pong = await withTimeout(this.redis.ping(), 2000);
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
