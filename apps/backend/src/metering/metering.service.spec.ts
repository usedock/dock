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

  describe('window swaps', () => {
    const size = { organizationId: orgId, workspaceId: 'ws-1', dockId: 'dock-1', cpus: 4, memoryMiB: 8192, diskGiB: 40 };
    const at = new Date('2026-01-01T00:00:00Z');
    let order: string[];
    let tx: any;

    beforeEach(() => {
      order = [];
      const closedAt: Date[] = [];
      tx = {
        update: vi.fn(() => ({ set: (v: { closedAt: Date }) => ({ where: () => { order.push('tx-close'); closedAt.push(v.closedAt); return Promise.resolve([]); } }) })),
        insert: vi.fn(() => ({ values: (v: Record<string, unknown>) => { order.push('tx-open'); stored = v; return { onConflictDoNothing: () => Promise.resolve([]) }; } })),
        closedAt,
      };
      db.transaction = vi.fn((cb: (t: unknown) => unknown) => cb(tx));
      db.update.mockReturnValue({ set: () => ({ where: () => { order.push('close'); return Promise.resolve([]); } }) });
      db.insert.mockReturnValue({ values: (v: Record<string, unknown>) => { order.push('open'); stored = v; return Promise.resolve([v]); } });
    });

    it('moves a stopped dock to a storage window in one transaction at one instant', async () => {
      await service.moveToStorage(size, at);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['tx-close', 'tx-open']);
      expect(tx.closedAt).toEqual([at]);
      expect(stored).toMatchObject({ unit: 'storage', dockId: 'dock-1', openedAt: at, cpus: 4, memoryMiB: 8192, diskGiB: 40 });
    });

    it('moves a resumed dock to a compute window in one transaction at one instant', async () => {
      await service.moveToCompute(size, at);
      expect(order).toEqual(['tx-close', 'tx-open']);
      expect(tx.closedAt).toEqual([at]);
      expect(stored).toMatchObject({ unit: 'compute', dockId: 'dock-1', openedAt: at, cpus: 4, memoryMiB: 8192, diskGiB: 40 });
    });

    it('uses the caller transaction and lets its errors propagate', async () => {
      tx.insert.mockImplementation(() => ({ values: () => ({ onConflictDoNothing: () => Promise.reject(new Error('db down')) }) }));
      await expect(service.moveToStorage(size, at, tx)).rejects.toThrow('db down');
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('falls back to separate writes when the swap transaction fails, so the old unit stops accruing', async () => {
      tx.insert.mockImplementation(() => ({ values: () => ({ onConflictDoNothing: () => Promise.reject(new Error('serialization failure')) }) }));
      await service.moveToStorage(size, at);
      expect(order).toEqual(['tx-close', 'close', 'open']);
      expect(stored).toMatchObject({ unit: 'storage', openedAt: at });
    });
  });

  it('records Fast Run target, runtime, and size', async () => {
    await service.openFastRunWindow({ organizationId: orgId, workspaceId: 'ws-1', runtimeId: 'fast-1', cpus: 1, memoryMiB: 2048, diskGiB: 10 });
    expect(stored).toMatchObject({ dockId: null, runtimeId: 'fast-1', executionTarget: 'fast', cpus: 1, memoryMiB: 2048, diskGiB: 10 });
  });
});
