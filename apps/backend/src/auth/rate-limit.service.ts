import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/**
 * Fixed-window counters in Redis. Redis errors fail closed (503) per design:
 * auth endpoints must not run unthrottled when the counter store is down.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; count: number }> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, windowSeconds);
      return { allowed: count <= limit, count };
    } catch (err) {
      throw new ServiceUnavailableException({
        code: 'service_unavailable',
        message: `Rate limiter unavailable: ${(err as Error).message}`,
      });
    }
  }
}
