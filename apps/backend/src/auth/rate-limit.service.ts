import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/**
 * INCR, then set the expiry whenever the key has none (TTL < 0): the first hit, or a key left
 * without a TTL. One script, so a crash between the two cannot strand a counter. Avoids
 * `EXPIRE ... NX`, which needs Redis 7.
 */
const HIT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count`;

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
