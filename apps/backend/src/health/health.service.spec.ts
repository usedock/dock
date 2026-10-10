import { HealthService } from './health.service';
import { vi, type Mock } from 'vitest';

describe('HealthService', () => {
  let pool: { query: Mock };
  let redis: { ping: Mock };
  let service: HealthService;

  beforeEach(() => {
    pool = { query: vi.fn() };
    redis = { ping: vi.fn() };
    service = new HealthService(pool as never, redis as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns up for both dependencies when all checks succeed', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    redis.ping.mockResolvedValue('PONG');

    await expect(service.checks()).resolves.toEqual({ postgres: 'up', redis: 'up' });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('returns postgres down when query rejects but redis stays up', async () => {
    pool.query.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue('PONG');

    await expect(service.checks()).resolves.toEqual({ postgres: 'down', redis: 'up' });
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it.each([['PONG', 'up'], ['OK', 'down']])(
    "maps redis ping resolving '%s' to '%s'",
    async (pong, expected) => {
      pool.query.mockResolvedValue({ rows: [] });
      redis.ping.mockResolvedValue(pong);

      await expect(service.checks()).resolves.toEqual({ postgres: 'up', redis: expected });
    },
  );

  it('returns redis down when ping rejects', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    redis.ping.mockRejectedValue(new Error('redis down'));

    await expect(service.checks()).resolves.toEqual({ postgres: 'up', redis: 'down' });
  });

  it('runs pg and redis checks in parallel', async () => {
    pool.query.mockRejectedValue(new Error('pg down'));
    redis.ping.mockResolvedValue('PONG');

    const result = await service.checks();

    expect(result).toEqual({ postgres: 'down', redis: 'up' });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  it('returns postgres down when query times out', async () => {
    vi.useFakeTimers();
    pool.query.mockReturnValue(new Promise<never>(() => undefined));
    redis.ping.mockResolvedValue('PONG');

    const resultPromise = service.checks();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(resultPromise).resolves.toEqual({ postgres: 'down', redis: 'up' });
  });

  it('returns redis down when ping times out', async () => {
    vi.useFakeTimers();
    pool.query.mockResolvedValue({ rows: [] });
    redis.ping.mockReturnValue(new Promise<never>(() => undefined));

    const resultPromise = service.checks();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(resultPromise).resolves.toEqual({ postgres: 'up', redis: 'down' });
  });
});
