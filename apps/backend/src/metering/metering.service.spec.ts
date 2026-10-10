import { vi } from 'vitest';
import { MeteringService } from './metering.service';

const orgId = '11111111-1111-4111-8111-111111111111';

describe('MeteringService', () => {
  let db: any;
  let service: MeteringService;
  let stored: Record<string, unknown>;

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    stored = {};
    db.insert.mockReturnValue({ values: (v: Record<string, unknown>) => { stored = v; return Promise.resolve([v]); } });
    service = new MeteringService(db as never);
  });

  it('records the dock size on the window', async () => {
    await service.openWindow({ organizationId: orgId, workspaceId: 'ws-1', dockId: 'dock-1', cpus: 8, memoryMiB: 16384, diskGiB: 80 });
    expect(stored).toMatchObject({ unit: 'compute', executionTarget: 'dock', cpus: 8, memoryMiB: 16384, diskGiB: 80 });
  });

  it('falls back to the default size', async () => {
    await service.openWindow({ organizationId: orgId, workspaceId: 'ws-1', dockId: 'dock-1' });
    expect(stored).toMatchObject({ cpus: 2, memoryMiB: 4096, diskGiB: 20 });
  });

  it('moves a stopped dock to a storage window after closing the open one', async () => {
    const order: string[] = [];
    db.update.mockReturnValue({ set: () => ({ where: () => { order.push('close'); return Promise.resolve([]); } }) });
    db.insert.mockReturnValue({ values: (v: Record<string, unknown>) => { order.push('open'); stored = v; return Promise.resolve([v]); } });
    const at = new Date('2026-01-01T00:00:00Z');
    await service.moveToStorage({ organizationId: orgId, workspaceId: 'ws-1', dockId: 'dock-1', cpus: 4, memoryMiB: 8192, diskGiB: 40 }, at);
    expect(order).toEqual(['close', 'open']);
    expect(stored).toMatchObject({ unit: 'storage', dockId: 'dock-1', openedAt: at, cpus: 4, memoryMiB: 8192, diskGiB: 40 });
  });

  it('records Fast Run target, runtime, and size', async () => {
    await service.openFastRunWindow({ organizationId: orgId, workspaceId: 'ws-1', runtimeId: 'fast-1', cpus: 1, memoryMiB: 2048, diskGiB: 10 });
    expect(stored).toMatchObject({ dockId: null, runtimeId: 'fast-1', executionTarget: 'fast', cpus: 1, memoryMiB: 2048, diskGiB: 10 });
  });
});
