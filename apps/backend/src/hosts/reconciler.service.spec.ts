import { BOOT_GRACE_MS, MISSING_GRACE_MS, RESCAN_MS, ReconcilerService } from './reconciler.service';
import { vi, type Mock } from 'vitest';

/** Vitest's named mock type; keeps helpers typed without anonymous inference. */
type MockFn = Mock;

describe('ReconcilerService', () => {
  let db: { select: MockFn; update: MockFn; transaction: MockFn };
  let hosts: { listOnline: MockFn; getById: MockFn; listOffline: MockFn; sweepOffline: MockFn };
  let config: { get: MockFn };
  let docklets: Mock;
  let client: { destroy: MockFn };
  let notifications: { dockStoppedResponding: MockFn };
  let metering: { closeWindowsForDock: MockFn; openWindow: MockFn; moveToStorage: MockFn };
  let service: ReconcilerService;

  const dockRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'd1',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    hostId: 'h1',
    name: 'dev',
    state: 'running',
    stateChangedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  });

  /** The host row carries the inventory the machine last reported. */
  const hostRow = (running: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({
    id: 'h1',
    state: 'online',
    usedDocks: 0,
    maxDocks: 8,
    running,
    lastHeartbeatAt: new Date('2026-10-01T00:10:00Z'),
    ...overrides,
  });

  const selectQ = (rows: Array<Record<string, unknown>>) => {
    const p = Promise.resolve(rows);
    return { from: () => ({ where: () => p }) };
  };

  beforeEach(() => {
    db = { select: vi.fn(), update: vi.fn(), transaction: vi.fn() };
    hosts = { listOnline: vi.fn(), getById: vi.fn(), listOffline: vi.fn().mockResolvedValue([]), sweepOffline: vi.fn().mockResolvedValue([]) };
    config = { get: vi.fn().mockReturnValue(undefined) };
    client = { destroy: vi.fn().mockResolvedValue(undefined) };
    docklets = vi.fn().mockResolvedValue(client);
    vi.clearAllMocks();
    db.transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
    // Default organization lookup for the metering move; docks lists are queued with mockReturnValueOnce.
    db.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }) }) });
    client.destroy.mockResolvedValue(undefined);
    notifications = { dockStoppedResponding: vi.fn().mockResolvedValue(null) };
    metering = { closeWindowsForDock: vi.fn().mockResolvedValue(undefined), openWindow: vi.fn().mockResolvedValue(undefined), moveToStorage: vi.fn().mockResolvedValue(undefined) };
    hosts.getById.mockResolvedValue(hostRow([]));
    service = new ReconcilerService(db as never, hosts as never, docklets as never, config as never, notifications as never, metering as never);
  });

  it('fences reported runtimes with no database row', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'ghost', state: 'running' }]));
    db.select.mockReturnValueOnce(selectQ([]));
    const result = await service.runOnce('h1');
    expect(client.destroy).toHaveBeenCalledWith('ghost');
    expect(result).toEqual({ fenced: ['ghost'], errored: [], recovered: [] });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('fences orphan gVisor containers through the same destroy path', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'orphan-gvisor', state: 'running' }], { id: 'host-gvisor' }));
    db.select.mockReturnValueOnce(selectQ([]));
    const result = await service.runOnce('host-gvisor');
    expect(client.destroy).toHaveBeenCalledWith('orphan-gvisor');
    expect(result).toEqual({ fenced: ['orphan-gvisor'], errored: [], recovered: [] });
  });

  it('skips kind fast runtimes on the container backend', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'gvisor-pool-slot', state: 'running', kind: 'fast' }], { id: 'host-gvisor' }));
    db.select.mockReturnValueOnce(selectQ([]));
    const result = await service.runOnce('host-gvisor');
    expect(client.destroy).not.toHaveBeenCalled();
    expect(result).toEqual({ fenced: [], errored: [], recovered: [] });
  });

  it('leaves fast agent runs to their owner', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'run-1', state: 'running', kind: 'fast' }]));
    db.select.mockReturnValueOnce(selectQ([]));
    const result = await service.runOnce('h1');
    expect(client.destroy).not.toHaveBeenCalled();
    expect(result).toEqual({ fenced: [], errored: [], recovered: [] });
  });

  it('marks db-running docks missing from reported inventory as error', async () => {
    let seenSet: Record<string, unknown> | undefined;
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1' })]));
    db.update.mockReturnValueOnce({
      set: (values: Record<string, unknown>) => {
        seenSet = values;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) };
      },
    });
    const result = await service.runOnce('h1');
    expect(seenSet).toMatchObject({ state: 'error', stateChangedAt: expect.any(Date) });
    expect(result).toEqual({ fenced: [], errored: ['d1'], recovered: [] });
    expect(client.destroy).not.toHaveBeenCalled();
    expect(notifications.dockStoppedResponding).toHaveBeenCalledWith({
      dockId: 'd1',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      dockName: 'dev',
      at: expect.any(Date),
    });
  });

  it('moves a missing dock to a storage window', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ id: 'd1', cpus: 4, memoryMiB: 8192, diskGiB: 40 })]))
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }) }) });
    db.update.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    await service.runOnce('h1');
    expect(metering.moveToStorage).toHaveBeenCalledWith({ organizationId: 'org-1', workspaceId: '22222222-2222-4222-8222-222222222222', dockId: 'd1', cpus: 4, memoryMiB: 8192, diskGiB: 40 }, expect.any(Date), db);
  });

  it('rolls the state change back when moving to storage fails', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ id: 'd1' })]))
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }) }) });
    db.update.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    metering.moveToStorage.mockRejectedValueOnce(new Error('db down'));
    await expect(service.runOnce('h1')).rejects.toThrow('db down');
    expect(notifications.dockStoppedResponding).not.toHaveBeenCalled();
  });

  it('does not overwrite a dock whose state changed since it was read', async () => {
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1' })]));
    db.update.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });
    const result = await service.runOnce('h1');
    expect(result).toEqual({ fenced: [], errored: [], recovered: [] });
    expect(metering.closeWindowsForDock).not.toHaveBeenCalled();
    expect(notifications.dockStoppedResponding).not.toHaveBeenCalled();
  });

  it('destroys reported runtimes whose dock row is archived', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'd1', state: 'running' }]));
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'archived' })]));
    const result = await service.runOnce('h1');
    expect(client.destroy).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ fenced: ['d1'], errored: [], recovered: [] });
  });

  it('marks live docks on offline hosts unreachable and stops their billing', async () => {
    hosts.listOffline.mockResolvedValueOnce([{ id: 'h1' }]);
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ id: 'd1' })]))
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }) }) });
    let seenSet: Record<string, unknown> | undefined;
    db.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => ((seenSet = v), { where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    await expect(service.sweepOfflineHosts(Date.now() + BOOT_GRACE_MS)).resolves.toEqual(['d1']);
    expect(seenSet).toMatchObject({ state: 'unreachable' });
    expect(hosts.sweepOffline).toHaveBeenCalledTimes(1);
    expect(metering.moveToStorage).toHaveBeenCalledWith(expect.objectContaining({ dockId: 'd1' }), expect.any(Date), db);
    expect(notifications.dockStoppedResponding).toHaveBeenCalledTimes(1);
  });

  it('does not sweep inside the boot grace', async () => {
    await expect(service.sweepOfflineHosts(Date.now() + BOOT_GRACE_MS - 5_000)).resolves.toEqual([]);
    expect(hosts.sweepOffline).not.toHaveBeenCalled();
  });

  it('recovers an unreachable dock the returned host reports and reopens billing', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'd1', state: 'running' }]));
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'unreachable', cpus: 2, memoryMiB: 4096, diskGiB: 20, billingPausedAt: null })]))
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }) }) });
    let seenSet: Record<string, unknown> | undefined;
    db.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => ((seenSet = v), { where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    const result = await service.runOnce('h1');
    expect(seenSet).toMatchObject({ state: 'ready' });
    expect(result).toEqual({ fenced: [], errored: [], recovered: ['d1'] });
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith('d1', expect.any(Date), db);
    expect(metering.openWindow).toHaveBeenCalledWith({ organizationId: 'org-1', workspaceId: '22222222-2222-4222-8222-222222222222', dockId: 'd1', cpus: 2, memoryMiB: 4096, diskGiB: 20, openedAt: metering.closeWindowsForDock.mock.calls[0][1] }, db);
  });

  it('errors an unreachable dock still absent from the returned host after the grace', async () => {
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'unreachable' })]));
    let seenSet: Record<string, unknown> | undefined;
    db.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => ((seenSet = v), { where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    const result = await service.runOnce('h1');
    expect(seenSet).toMatchObject({ state: 'error' });
    expect(result).toEqual({ fenced: [], errored: ['d1'], recovered: [] });
    expect(metering.openWindow).not.toHaveBeenCalled();
  });

  it('recovers without reopening billing when a refused stop paused it', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'd1', state: 'running' }]));
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'unreachable', billingPausedAt: new Date() })]));
    db.update.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    const result = await service.runOnce('h1');
    expect(result.recovered).toEqual(['d1']);
    expect(metering.openWindow).not.toHaveBeenCalled();
  });

  it('self-heals an errored dock whose runtime the host reports', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'd1', state: 'running' }]));
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'error', liveSince: new Date('2026-10-01T00:00:00Z'), cpus: 2, memoryMiB: 4096, diskGiB: 20, billingPausedAt: null })]))
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }) }) });
    let seenSet: Record<string, unknown> | undefined;
    db.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => ((seenSet = v), { where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    const result = await service.runOnce('h1');
    expect(seenSet).toMatchObject({ state: 'ready' });
    expect(result.recovered).toEqual(['d1']);
    expect(metering.openWindow).toHaveBeenCalledTimes(1);
  });

  it('fences an errored dock that never went live instead of reviving it', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'd1', state: 'running' }]));
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'error', liveSince: null })]));
    const result = await service.runOnce('h1');
    expect(client.destroy).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ fenced: ['d1'], errored: [], recovered: [] });
    expect(db.update).not.toHaveBeenCalled();
    expect(metering.openWindow).not.toHaveBeenCalled();
  });

  it('still reports the dock as errored when the notification rejects', async () => {
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1' })]));
    db.update.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'd1' }]) }) }) });
    notifications.dockStoppedResponding.mockRejectedValueOnce(new Error('smtp down'));
    const result = await service.runOnce('h1');
    expect(result.errored).toEqual(['d1']);
  });

  it('keeps sweeping when one dock update throws', async () => {
    hosts.listOffline.mockResolvedValueOnce([{ id: 'h1' }]);
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1' }), dockRow({ id: 'd2' })]));
    db.update
      .mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.reject(new Error('db blip')) }) }) })
      .mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'd2' }]) }) }) });
    await expect(service.sweepOfflineHosts(Date.now() + BOOT_GRACE_MS)).resolves.toEqual(['d2']);
  });

  it('leaves an unreachable dock alone inside the grace window and the extra rescan interval', async () => {
    const heartbeat = new Date('2026-10-01T00:10:00Z');
    const inGrace = new Date(heartbeat.getTime() - MISSING_GRACE_MS - 5_000);
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'unreachable', stateChangedAt: inGrace })]));
    expect(await service.runOnce('h1')).toEqual({ fenced: [], errored: [], recovered: [] });
    const pastGraceInRescan = new Date(heartbeat.getTime() - MISSING_GRACE_MS - RESCAN_MS + 5_000);
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'unreachable', stateChangedAt: pastGraceInRescan })]));
    expect(await service.runOnce('h1')).toEqual({ fenced: [], errored: [], recovered: [] });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('treats ready and idle docks as live when absent from inventory', async () => {
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd2', state: 'ready' }), dockRow({ id: 'd3', state: 'idle' })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'x' }]) }) }) });
    const result = await service.runOnce('h1');
    expect(result).toEqual({ fenced: [], errored: ['d2', 'd3'], recovered: [] });
    expect(notifications.dockStoppedResponding).toHaveBeenCalledTimes(2);
  });

  it('leaves docks that are not live alone when absent from inventory', async () => {
    db.select.mockReturnValueOnce(
      selectQ([dockRow({ id: 'd2', state: 'provisioning' }), dockRow({ id: 'd3', state: 'archived' })]),
    );
    const result = await service.runOnce('h1');
    expect(db.update).not.toHaveBeenCalled();
    expect(result).toEqual({ fenced: [], errored: [], recovered: [] });
  });

  it('waits for a heartbeat taken after the dock went live before calling it missing', async () => {
    const heartbeat = new Date('2026-10-01T00:10:00Z');
    db.select.mockReturnValueOnce(selectQ([dockRow({ stateChangedAt: new Date(heartbeat.getTime() - 5_000) })]));
    expect(await service.runOnce('h1')).toEqual({ fenced: [], errored: [], recovered: [] });
    hosts.getById.mockResolvedValueOnce(hostRow([], { lastHeartbeatAt: null }));
    db.select.mockReturnValueOnce(selectQ([dockRow()]));
    expect(await service.runOnce('h1')).toEqual({ fenced: [], errored: [], recovered: [] });
    expect(db.update).not.toHaveBeenCalled();
    expect(notifications.dockStoppedResponding).not.toHaveBeenCalled();
  });

  it('is a no-op when reported inventory and database converge', async () => {
    hosts.getById.mockResolvedValueOnce(hostRow([{ dockId: 'd1', state: 'running' }]));
    db.select.mockReturnValueOnce(selectQ([dockRow({ id: 'd1', state: 'running' })]));
    const result = await service.runOnce('h1');
    expect(client.destroy).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(result).toEqual({ fenced: [], errored: [], recovered: [] });
  });

  it('resolves the client per host id', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    await service.runOnce('h9');
    expect(docklets).toHaveBeenCalledWith('h9');
  });

  it('repairs from the last reported inventory without asking the host to answer', async () => {
    // A host that has gone quiet still exposes the inventory it last sent, so
    // reconcile must not depend on the host being reachable.
    hosts.getById.mockResolvedValueOnce(
      hostRow([{ dockId: 'ghost', state: 'running' }], { state: 'offline' }),
    );
    db.select.mockReturnValueOnce(selectQ([]));
    client.destroy.mockRejectedValueOnce(new Error('host_unreachable'));
    const result = await service.runOnce('h1');
    expect(result).toEqual({ fenced: [], errored: [], recovered: [] });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('isolates an unreachable host from the rest of the tick', async () => {
    const bad = { destroy: vi.fn() };
    hosts.listOnline.mockResolvedValueOnce([{ id: 'bad' }, { id: 'good' }]);
    hosts.getById.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('down');
      return hostRow([]);
    });
    docklets.mockImplementation(async (id: string) => (id === 'bad' ? bad : client));
    db.select.mockReturnValueOnce(selectQ([]));
    // ReconcilerService keeps the tick private; drive it directly to observe isolation.
    const tick: { reconcileAll: () => Promise<void> } = service as unknown as typeof service & {
      reconcileAll: () => Promise<void>;
    };
    await tick.reconcileAll();
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
