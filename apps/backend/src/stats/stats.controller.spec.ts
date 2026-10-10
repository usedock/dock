import { BadRequestException, HttpException } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { vi, type Mock } from 'vitest';

describe('StatsController', () => {
  let stats: { current: Mock; window: Mock; checkedWindow: Mock };
  let docks: { loadDock: Mock };
  let controller: StatsController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };
  const sample = {
    dockId: 'd1',
    at: new Date('2026-09-01T00:00:00.000Z'),
    cpuPercent: 12.5,
    memBytes: 1024,
    memLimit: 2048,
    diskBytes: 4096,
    rxBytes: 100,
    txBytes: 200,
    source: 'host',
  };

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
    stats = { current: vi.fn(), window: vi.fn(), checkedWindow: vi.fn((w: unknown) => w) };
    docks = { loadDock: vi.fn().mockResolvedValue({ dock: { id: 'd1', state: 'ready' }, orgId: 'org-1' }) };
    controller = new StatsController(stats as never, docks as never);
  });

  it('reads the current sample scoped to the user', async () => {
    stats.current.mockResolvedValue(sample);
    const res = await controller.getStats(user, 'd1', {});
    expect(docks.loadDock).toHaveBeenCalledWith('u1', 'd1');
    expect(stats.current).toHaveBeenCalledWith('d1');
    expect(res).toMatchObject({ dockId: 'd1', state: 'ready', sample: { cpuPercent: 12.5 } });
    expect(res).not.toHaveProperty('window');
    expect('containers' in (res.sample as unknown as Record<string, unknown>)).toBe(false);
  });

  it('returns a null sample when the dock never reported', async () => {
    stats.current.mockResolvedValue(null);
    const res = await controller.getStats(user, 'd1', {});
    expect(res).toMatchObject({ dockId: 'd1', sample: null });
  });

  it('passes the window through after validation', async () => {
    stats.current.mockResolvedValue(null);
    stats.window.mockResolvedValue({ window: '24h', samples: 2, avg: {}, peak: {} });
    const res = await controller.getStats(user, 'd1', { window: '24h' });
    expect(stats.checkedWindow).toHaveBeenCalledWith('24h');
    expect(stats.window).toHaveBeenCalledWith('d1', '24h');
    expect(res).toMatchObject({ window: { window: '24h', samples: 2 } });
  });

  it('rejects invalid windows with 400', async () => {
    stats.checkedWindow.mockImplementation(() => {
      throw new BadRequestException({ code: 'validation_error', message: 'window must be 1h or 24h' });
    });
    const err = await catchErr(controller.getStats(user, 'd1', { window: '7d' } as never));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(stats.window).not.toHaveBeenCalled();
  });

  it('returns the last sample for archived docks', async () => {
    docks.loadDock.mockResolvedValueOnce({ dock: { id: 'd1', state: 'archived' }, orgId: 'org-1' });
    stats.current.mockResolvedValue(sample);
    const res = await controller.getStats(user, 'd1', {});
    expect(res).toMatchObject({ dockId: 'd1', state: 'archived', sample: { cpuPercent: 12.5 } });
  });
});
