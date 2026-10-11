import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/**
 * Fixed-window counters in Redis. Redis errors fail closed (503) per design:
 * auth endpoints must not run unthrottled when the counter store is down.
 */
/** INCR and EXPIRE NX in one script, so a crash between them cannot leave a counter without a TTL. */
const HIT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1], 'NX')
return count`;

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; count: number }> {
    try {
      const count = Number(await this.redis.eval(HIT_SCRIPT, 1, key, windowSeconds));
      return { allowed: count <= limit, count };
    } catch (err) {
      throw new ServiceUnavailableException({
        code: 'service_unavailable',
        message: `Rate limiter unavailable: ${(err as Error).message}`,
      });
    }
  }
}
