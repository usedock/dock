import { HttpException } from '@nestjs/common';
import { RAW_RETENTION_DAYS, StatsService } from './stats.service';
import { vi } from 'vitest';

describe('StatsService', () => {
  let db: any;
  let redis: any;
  let service: StatsService;

  const dockId = '33333333-3333-4333-8333-333333333333';
  const input = { cpuPercent: 12.5, memBytes: 1024, memLimit: 2048, diskBytes: 4096, rxBytes: 100, txBytes: 200 };
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'stat-1',
    dockId,
    at: new Date('2026-09-01T00:00:00.000Z'),
    cpuPercent: 12.5,
    memBytes: 1024,
    memLimit: 2048,
    diskBytes: 4096,
    rxBytes: 100,
    txBytes: 200,
    containers: null,
    source: 'host',
    ...overrides,
  });

  const selectQ = (rows: any[]) => {
    const settled = Promise.resolve(rows);
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(() => settled) })),
          limit: vi.fn(() => settled),
          then: settled.then.bind(settled),
        })),
      })),
    };
  };
  const insertQ = (rows: any[]) => ({
    values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(rows) })),
  });
  const deleteQ = (rows: any[]) => ({
    where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(rows) })),
  });

  async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected rejection');
  }

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    redis = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
    vi.clearAllMocks();
    service = new StatsService(db as never, redis as never);
  });

  it('records history and refreshes the hot sample', async () => {
    db.insert.mockReturnValueOnce(insertQ([row()]));
    redis.set.mockResolvedValueOnce('OK');
    const sample = await service.record(dockId, input);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(`stats:dock:${dockId}`, expect.stringContaining('12.5'), 'EX', 90);
    expect(sample).toMatchObject({ dockId, cpuPercent: 12.5, memBytes: 1024, source: 'host' });
    expect('containers' in sample).toBe(false);
  });

  it('keeps history when the hot write fails', async () => {
    db.insert.mockReturnValueOnce(insertQ([row()]));
    redis.set.mockRejectedValueOnce(new Error('down'));
    await expect(service.record(dockId, input)).resolves.toMatchObject({ dockId });
  });

  it('prefers the hot sample over history', async () => {
    redis.get.mockResolvedValueOnce(
      JSON.stringify({ at: '2026-09-01T00:00:00.000Z', cpuPercent: 9, memBytes: 1, memLimit: 2, diskBytes: 3, rxBytes: 4, txBytes: 5, source: 'host' }),
    );
    await expect(service.current(dockId)).resolves.toMatchObject({ dockId, cpuPercent: 9, memBytes: 1 });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('falls back to the latest row, then null', async () => {
    redis.get.mockResolvedValueOnce(null);
    db.select.mockReturnValueOnce(selectQ([row({ containers: [{ name: 'web', cpuPercent: 1, memBytes: 2 }] })]));
    await expect(service.current(dockId)).resolves.toMatchObject({
      dockId,
      containers: [{ name: 'web', cpuPercent: 1, memBytes: 2 }],
    });
    redis.get.mockResolvedValueOnce(null);
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.current(dockId)).resolves.toBeNull();
  });

  it('falls back when the hot cache is corrupt', async () => {
    redis.get.mockResolvedValueOnce('not-json');
    db.select.mockReturnValueOnce(selectQ([row()]));
    await expect(service.current(dockId)).resolves.toMatchObject({ dockId });
  });

  it('aggregates windowed avg and peak', async () => {
    db.select.mockReturnValueOnce(
      selectQ([
        { samples: 4, avgCpu: '10', maxCpu: 20, avgMem: '100', maxMem: 200, avgMemLimit: '300', maxMemLimit: 400, avgDisk: '500', maxDisk: 600, avgRx: '1', maxRx: 2, avgTx: '3', maxTx: 4 },
      ]),
    );
    const agg = await service.window(dockId, '24h');
    expect(agg).toMatchObject({
      window: '24h',
      samples: 4,
      avg: { cpuPercent: 10, memBytes: 100, txBytes: 3 },
      peak: { cpuPercent: 20, memBytes: 200, txBytes: 4 },
    });
  });

  it('returns zeros for empty windows', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const empty = await service.window(dockId, '1h');
    expect(empty).toEqual({
      window: '1h',
      samples: 0,
      avg: { cpuPercent: 0, memBytes: 0, memLimit: 0, diskBytes: 0, rxBytes: 0, txBytes: 0 },
      peak: { cpuPercent: 0, memBytes: 0, memLimit: 0, diskBytes: 0, rxBytes: 0, txBytes: 0 },
    });
    db.select.mockReturnValueOnce(
      selectQ([{ samples: 0, avgCpu: null, maxCpu: null, avgMem: null, maxMem: null, avgMemLimit: null, maxMemLimit: null, avgDisk: null, maxDisk: null, avgRx: null, maxRx: null, avgTx: null, maxTx: null }]),
    );
    await expect(service.window(dockId, '1h')).resolves.toMatchObject({ samples: 0 });
  });

  it('rejects unknown windows', async () => {
    const err = await catchErr(service.window(dockId, '7d' as never));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
  });

  it('purges rows older than retention', async () => {
    expect(RAW_RETENTION_DAYS).toBe(7);
    db.delete.mockReturnValueOnce(deleteQ([{ id: 'a' }, { id: 'b' }]));
    await expect(service.purge()).resolves.toBe(2);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('purges shortly after init, then hourly, and stops on destroy', async () => {
    vi.useFakeTimers();
    try {
      const purge = vi.spyOn(service, 'purge').mockResolvedValue(0);
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(purge).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(purge).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(purge).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
