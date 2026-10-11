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
    expect(script).not.toContain('NX');
    expect([numKeys, key, ttl]).toEqual([1, 'rl:k', 60]);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  describe('expiry script', () => {
    async function script(): Promise<string> {
      const redis = { eval: vi.fn().mockResolvedValue(1) };
      await new RateLimitService(redis as never).hit('rl:k', 3, 60);
      return redis.eval.mock.calls[0][0] as string;
    }

    it('sets the TTL on the first hit (new key has TTL -1)', async () => {
      const s = await script();
      expect(s).toContain("redis.call('TTL', KEYS[1]) < 0");
      expect(s).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])");
      expect(s.indexOf('INCR')).toBeLessThan(s.indexOf('TTL'));
    });

    it('keeps the TTL on later hits (EXPIRE only runs inside the TTL < 0 branch)', async () => {
      const s = await script();
      expect(s.indexOf("'TTL'")).toBeLessThan(s.indexOf("'EXPIRE'"));
      expect(s.match(/EXPIRE/g)).toHaveLength(1);
    });

    it('gives a key without a TTL an expiry (TTL < 0 also covers -1 on an existing key)', async () => {
      expect(await script()).toMatch(/TTL', KEYS\[1\]\) < 0/);
    });
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
