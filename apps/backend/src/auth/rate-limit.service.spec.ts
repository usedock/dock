import { ServiceUnavailableException } from '@nestjs/common';
import { vi } from 'vitest';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitService.hit', () => {
  it('increments and sets expiry in one atomic script call', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(2), incr: vi.fn(), expire: vi.fn() };
    const svc = new RateLimitService(redis as never);

    await expect(svc.hit('rl:k', 3, 60)).resolves.toEqual({ allowed: true, count: 2 });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, ttl] = redis.eval.mock.calls[0];
    expect(script).toContain('INCR');
    expect(script).toContain("'NX'");
    expect([numKeys, key, ttl]).toEqual([1, 'rl:k', 60]);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('refuses once the count passes the limit', async () => {
    const svc = new RateLimitService({ eval: vi.fn().mockResolvedValue(4) } as never);
    await expect(svc.hit('rl:k', 3, 60)).resolves.toEqual({ allowed: false, count: 4 });
  });

  it('fails closed with 503 when Redis errors', async () => {
    const svc = new RateLimitService({ eval: vi.fn().mockRejectedValue(new Error('down')) } as never);
    await expect(svc.hit('rl:k', 3, 60)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
