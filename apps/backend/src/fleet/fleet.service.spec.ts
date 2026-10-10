import { ConflictException, HttpException } from '@nestjs/common';
import { FleetService } from './fleet.service';
import { vi } from 'vitest';

describe('FleetService', () => {
  let hostsService: { register: ReturnType<typeof vi.fn>; heartbeat: ReturnType<typeof vi.fn>; issueCredential: ReturnType<typeof vi.fn>; enrollHost: ReturnType<typeof vi.fn>; registerUnenrolled: ReturnType<typeof vi.fn>; dockIdsOnHost: ReturnType<typeof vi.fn> };
  let stats: { record: ReturnType<typeof vi.fn> };
  let notifications: { evaluateDisk: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let service: FleetService;

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
    hostsService = { register: vi.fn().mockResolvedValue(undefined), heartbeat: vi.fn().mockResolvedValue(undefined), issueCredential: vi.fn().mockResolvedValue('hc_new'), enrollHost: vi.fn().mockResolvedValue('hc_enrolled'), registerUnenrolled: vi.fn().mockResolvedValue('hc_new'), dockIdsOnHost: vi.fn(async (_host: string, ids: string[]) => new Set(ids)) };
    stats = { record: vi.fn().mockResolvedValue(undefined) };
    config = { get: vi.fn(() => undefined) };
    notifications = { evaluateDisk: vi.fn().mockResolvedValue(null) };
    service = new FleetService(hostsService as never, stats as never, config as never, notifications as never);
  });

  it('enrolls a fresh machine with a generated hostId', async () => {
    const result = await service.enroll({});
    expect(result.hostId).toMatch(/^host-/);
    expect(result.pollWaitSeconds).toBe(25);
  });

  it('issues the credential at enrollment', async () => {
    const result = await service.enroll({ hostId: 'h1', runtime: 'gvisor' });
    expect(hostsService.enrollHost).toHaveBeenCalledWith('h1', 'gvisor');
    expect(result).toMatchObject({ hostId: 'h1', credential: 'hc_enrolled' });
  });

  it('propagates 409 when the host is already enrolled', async () => {
    hostsService.enrollHost.mockRejectedValue(new ConflictException({ code: 'host_already_enrolled', message: 'x' }));
    expect((await catchErr(service.enroll({ hostId: 'h1' }))).status).toBe(409);
  });

  it('refuses shared-token registration of an enrolled host without touching its row', async () => {
    hostsService.registerUnenrolled.mockRejectedValue(new ConflictException({ code: 'host_already_enrolled', message: 'x' }));
    const input = { hostId: 'h1', cpuFamily: 'x86_64-v4', kernel: '6.8.0', maxDocks: 8 };
    expect((await catchErr(service.register(input, true))).status).toBe(409);
    expect(hostsService.register).not.toHaveBeenCalled();
  });

  it('rejects an unknown enroll runtime', async () => {
    const err = await catchErr(service.enroll({ runtime: 'docker' as never }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
  });

  it('registers through the host service with an outbound address', async () => {
    await service.register({ hostId: 'h1', cpuFamily: 'x86_64-v4', kernel: '6.8.0', maxDocks: 8 }, false);
    expect(hostsService.register).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'h1', address: 'outbound' }),
    );
  });

  const input = { hostId: 'h1', cpuFamily: 'x86_64-v4', kernel: '6.8.0', maxDocks: 8 };

  it('issues a credential on shared-token registration only for a docklet that accepts one', async () => {
    await expect(service.register({ ...input, acceptsCredential: true }, true)).resolves.toMatchObject({ hostId: 'h1', credential: 'hc_new' });
    expect(hostsService.registerUnenrolled).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: 'h1', address: 'outbound' }), true);
    expect(hostsService.registerUnenrolled.mock.calls.at(-1)?.[0]).not.toHaveProperty('acceptsCredential');
  });

  it('keeps an older docklet credential-less under the legacy flag', async () => {
    hostsService.registerUnenrolled.mockResolvedValue(undefined);
    const result = await service.register(input, true);
    expect(hostsService.registerUnenrolled).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(result).not.toHaveProperty('credential');
  });

  it('never issues a credential when a host registers with its own', async () => {
    const kept = await service.register({ ...input, acceptsCredential: true }, false);
    expect(kept).not.toHaveProperty('credential');
    expect(hostsService.registerUnenrolled).not.toHaveBeenCalled();
  });

  it('drops samples for docks not placed on the calling host', async () => {
    hostsService.dockIdsOnHost.mockResolvedValue(new Set(['d1']));
    await service.heartbeat({
      hostId: 'h1',
      running: [],
      samples: [
        { dockId: 'd1', cpuPercent: 5, memBytes: 100, memLimit: 200, diskBytes: 300, rxBytes: 1, txBytes: 2 },
        { dockId: 'tenant-b-dock', cpuPercent: 6, memBytes: 1, memLimit: 2, diskBytes: 3, rxBytes: 4, txBytes: 5 },
      ],
    });
    expect(hostsService.dockIdsOnHost).toHaveBeenCalledWith('h1', ['d1', 'tenant-b-dock']);
    expect(stats.record).toHaveBeenCalledTimes(1);
    expect(stats.record).toHaveBeenCalledWith('d1', expect.anything());
  });

  it('forwards heartbeat inventory to the host registry', async () => {
    await service.heartbeat({ hostId: 'h1', usedDocks: 2, running: [] });
    expect(hostsService.heartbeat).toHaveBeenCalledWith('h1', { usedDocks: 2, running: [] });
    expect(stats.record).not.toHaveBeenCalled();
  });

  it('forwards the base fingerprints a host reports', async () => {
    const fp = '9'.repeat(64);
    await service.heartbeat({ hostId: 'h1', running: [], baseFingerprints: [fp] });
    expect(hostsService.heartbeat).toHaveBeenCalledWith('h1', expect.objectContaining({ baseFingerprints: [fp] }));
  });

  it('forwards the runtime a heartbeat reports', async () => {
    await service.heartbeat({ hostId: 'h1', runtime: 'gvisor', running: [] });
    expect(hostsService.heartbeat).toHaveBeenCalledWith('h1', expect.objectContaining({ runtime: 'gvisor' }));
  });

  it('records every host-truth sample riding the heartbeat', async () => {
    await service.heartbeat({
      hostId: 'h1',
      running: [],
      samples: [
        { dockId: 'd1', cpuPercent: 5, memBytes: 100, memLimit: 200, diskBytes: 300, rxBytes: 1, txBytes: 2 },
        { dockId: 'd2', cpuPercent: 6, memBytes: 101, memLimit: 201, diskBytes: 301, rxBytes: 3, txBytes: 4, source: 'guest', at: '2026-10-08T00:00:00.000Z' },
      ],
    });
    expect(stats.record).toHaveBeenCalledTimes(2);
    expect(stats.record).toHaveBeenCalledWith('d1', expect.objectContaining({ cpuPercent: 5, source: 'host' }));
    expect(stats.record).toHaveBeenCalledWith(
      'd2',
      expect.objectContaining({ cpuPercent: 6, source: 'guest', at: new Date('2026-10-08T00:00:00.000Z') }),
    );
  });

  it('does not let one bad sample fail the heartbeat a host liveness depends on', async () => {
    stats.record.mockRejectedValueOnce(new Error('unknown dock')).mockResolvedValueOnce(undefined);
    await expect(
      service.heartbeat({
        hostId: 'h1',
        running: [],
        samples: [
          { dockId: 'ghost', cpuPercent: 1, memBytes: 1, memLimit: 1, diskBytes: 1, rxBytes: 1, txBytes: 1 },
          { dockId: 'd2', cpuPercent: 1, memBytes: 1, memLimit: 1, diskBytes: 1, rxBytes: 1, txBytes: 1 },
        ],
      }),
    ).resolves.toEqual({ hostId: 'h1' });
    expect(stats.record).toHaveBeenCalledTimes(2);
  });

  it('evaluates disk alerts on occupancy only when the sample carries it', async () => {
    await service.heartbeat({
      hostId: 'h1',
      running: [],
      samples: [
        { dockId: 'd1', cpuPercent: 1, memBytes: 1, memLimit: 1, diskBytes: 9, diskUsedBytes: 42, rxBytes: 1, txBytes: 1 },
        { dockId: 'd2', cpuPercent: 1, memBytes: 1, memLimit: 1, diskBytes: 9, rxBytes: 1, txBytes: 1 },
      ],
    });
    expect(notifications.evaluateDisk).toHaveBeenCalledTimes(1);
    expect(notifications.evaluateDisk).toHaveBeenCalledWith('d1', 42);
  });
});
