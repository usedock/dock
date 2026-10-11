import { ForbiddenException, HttpException } from '@nestjs/common';
import { FakeComputeProvider } from '../docks/compute.provider';
import { TemplateLimitReachedException, TemplatesService } from './templates.service';
import { vi } from 'vitest';

describe('TemplatesService', () => {
  let db: any;
  let docks: any;
  let orgs: any;
  let retention: any;
  let ops: any;
  let provider: FakeComputeProvider;
  let service: TemplatesService;

  const orgId = '11111111-1111-4111-8111-111111111111';
  const dockId = '33333333-3333-4333-8333-333333333333';
  const dockRow = (overrides: Record<string, unknown> = {}) => ({
    id: dockId,
    workspaceId: 'ws-1',
    name: 'dock-abc',
    runtime: 'microvm',
    state: 'ready',
    env: {},
    envVersionPin: 'base',
    fromTemplate: null,
    diskBytes: 0,
    ...overrides,
  });
  const tplRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'tpl-1',
    organizationId: orgId,
    name: 'web-stack',
    sourceDockId: dockId,
    status: 'ready',
    sizeBytes: 6000,
    snapshotRef: 'snap-1',
    storeSnapshotId: null,
    ...overrides,
  });

  const captureWith = (snapshotId: string) => ({
    snapshotId,
    sizeBytes: 6000,
    cpuFamily: 'fake',
    runtime: 'microvm',
    kernelRelease: null,
    manifest: { files: [] },
  });

  const selectQ = (rows: any[]) => {
    const p = Promise.resolve(rows);
    const orderBy = () => ({ limit: () => p, then: p.then.bind(p) });
    const where = () => ({ orderBy, limit: () => p, then: p.then.bind(p) });
    return { from: () => ({ where }) };
  };
  const insertQ = (rows: any[]) => ({
    values: () => ({ returning: () => Promise.resolve(rows) }),
  });
  // Every column set() writes lands in `persisted`, which is the row the
  // service left in the database once the transaction is done.
  const txWith = (selects: any[][], inserts: any[][], persisted: Record<string, unknown> = {}) => {
    const tx: any = { execute: vi.fn().mockResolvedValue([]) };
    const sel = vi.fn();
    selects.forEach((rows) => sel.mockReturnValueOnce(selectQ(rows)));
    tx.select = sel;
    const ins = vi.fn();
    inserts.forEach((rows) => ins.mockReturnValueOnce(insertQ(rows)));
    tx.insert = ins;
    tx.update = vi.fn().mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        Object.assign(persisted, values);
        return { where: () => ({ returning: () => Promise.resolve([{ ...tplRow(), ...persisted }]) }) };
      },
    }));
    tx.delete = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    return tx;
  };

  let removeTxDelete: any;
  // Remove runs its lookup-and-delete in a locked transaction that re-reads the row.
  const removeTx = (row: any) => {
    removeTxDelete = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    const tx = { execute: vi.fn().mockResolvedValue([]), select: () => selectQ([row]), delete: removeTxDelete };
    db.transaction.mockImplementationOnce(async (fn: any) => fn(tx));
    return tx;
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
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() };
    vi.clearAllMocks();
    docks = { loadDock: vi.fn().mockResolvedValue({ dock: dockRow(), orgId }), reapply: vi.fn().mockResolvedValue(undefined) };
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    retention = { policyOn: vi.fn().mockResolvedValue(false) };
    ops = {
      create: vi.fn().mockResolvedValue({ id: 'op_1', status: 'pending' }),
      complete: vi.fn().mockResolvedValue({ id: 'op_1', status: 'completed' }),
    };
    provider = new FakeComputeProvider();
    service = new TemplatesService(
      db as never,
      docks as never,
      orgs as never,
      retention as never,
      ops as never,
      provider as never,
    );
  });

  it('validates template names', async () => {
    for (const name of ['', 'A', 'has space', 'x']) {
      const err = await catchErr(service.save('u1', dockId, name));
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: 'validation_error' });
    }
    expect(docks.loadDock).not.toHaveBeenCalled();
  });

  it('requires admin through the dock', async () => {
    docks.loadDock.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(403);
  });

  it.each(['unreachable', 'error'])('refuses saves from a %s dock without capturing', async (state) => {
    docks.loadDock.mockResolvedValueOnce({ dock: dockRow({ state }), orgId });
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'dock_not_running' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('refuses saves while retention is enabled', async () => {
    retention.policyOn.mockResolvedValueOnce(true);
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'zdr_blocks_templates' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('enforces ten templates per organization', async () => {
    const tx = txWith(
      [[], Array.from({ length: 10 }, (_, i) => ({ id: `tpl-${i}` }))],
      [],
    );
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const err = await catchErr(service.save('u1', dockId, 'eleventh'));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'template_limit_reached' });
    expect(new TemplateLimitReachedException().getStatus()).toBe(409);
  });

  it('saves from a running dock and returns the ready row with its capture source', async () => {
    const tx = txWith(
      [[], [], []], // existing, count, latest
      [[tplRow({ status: 'saving' })]], // insert saving
    );
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const saved = await service.save('u1', dockId, 'web-stack');
    expect(saved).toMatchObject({ name: 'web-stack', status: 'ready', cpuFamily: 'fake', runtime: 'microvm' });
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('failed re-saves keep the last good save', async () => {
    provider.failNextCapture(1);
    const tx = txWith(
      [[tplRow()], []], // existing, latest
      [],
    );
    const restored: Record<string, unknown> = {};
    db.update.mockReturnValue({
      set: (values: Record<string, unknown>) => {
        Object.assign(restored, values);
        return { where: () => Promise.resolve([]) };
      },
    });
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(503);
    // Only the reservation touched the row inside a transaction; the old status is restored after.
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(restored.status).toBe('ready');
  });

  it('captures outside any transaction and finalizes in a second one', async () => {
    let open = 0;
    let transactions = 0;
    const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]]);
    db.transaction.mockImplementation(async (fn: any) => {
      transactions += 1;
      open += 1;
      try {
        return await fn(tx);
      } finally {
        open -= 1;
      }
    });
    let openDuringCapture = -1;
    vi.spyOn(provider, 'captureSnapshot').mockImplementation(async () => {
      openDuringCapture = open;
      return captureWith('gen-created');
    });
    await service.save('u1', dockId, 'web-stack');
    expect(openDuringCapture).toBe(0);
    expect(transactions).toBe(2);
  });

  describe('connector docks', () => {
    const save = async (dock: Record<string, unknown>) => {
      docks.loadDock.mockResolvedValue({ dock, orgId });
      const persisted: Record<string, unknown> = {};
      const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]], persisted);
      db.transaction.mockImplementation(async (fn: any) => fn(tx));
      await service.save('u1', dockId, 'web-stack');
      return persisted;
    };

    it('records that the source had connectors and re-applies it so the captured token dies', async () => {
      const dock = dockRow({ connectors: ['linear'] });
      const persisted = await save(dock);
      expect(persisted.hadConnectors).toBe(true);
      expect(docks.reapply).toHaveBeenCalledWith(dock, orgId);
    });

    it('records false and leaves the source alone without connectors', async () => {
      const persisted = await save(dockRow({ connectors: [] }));
      expect(persisted.hadConnectors).toBe(false);
      expect(docks.reapply).not.toHaveBeenCalled();
    });

    it('re-applies a source holding an LLM gateway token so the captured token dies', async () => {
      const dock = dockRow({ connectors: [], llmTokenHash: 'h' });
      const persisted = await save(dock);
      expect(persisted.hadConnectors).toBe(false);
      expect(docks.reapply).toHaveBeenCalledWith(dock, orgId);
    });

    it('still saves when the re-apply fails', async () => {
      docks.reapply.mockRejectedValueOnce(new Error('exec down'));
      const persisted = await save(dockRow({ connectors: ['linear'] }));
      expect(persisted.status).toBe('ready');
    });
  });

  it('fails fast without capturing when the name is already being saved', async () => {
    const capture = vi.spyOn(provider, 'captureSnapshot');
    const tx = txWith([[tplRow({ status: 'saving', updatedAt: new Date() })]], []);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(409);
    expect(capture).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('deletes a fresh reservation when its capture fails so the name can be reused', async () => {
    provider.failNextCapture(1);
    const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]]);
    const remove = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValue({ where: remove });
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(503);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('reclaims a saving row whose save is older than the capture deadline', async () => {
    const stale = tplRow({ status: 'saving', updatedAt: new Date(Date.now() - 3_600_000), savingSince: null });
    const tx = txWith([[stale], []], []);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const saved = await service.save('u1', dockId, 'web-stack');
    expect(saved).toMatchObject({ status: 'ready' });
  });

  it('keeps a re-saved ready template ready and rejects a concurrent re-save', async () => {
    const persisted: Record<string, unknown> = {};
    const tx = txWith([[tplRow()], []], [], persisted);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    let statusDuringCapture: unknown;
    vi.spyOn(provider, 'captureSnapshot').mockImplementation(async () => {
      statusDuringCapture = persisted.status;
      return captureWith('gen-new');
    });
    await service.save('u1', dockId, 'web-stack');
    expect(statusDuringCapture).toBeUndefined();
    const busy = txWith([[tplRow({ savingSince: new Date() })]], []);
    db.transaction.mockImplementation(async (fn: any) => fn(busy));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(409);
  });

  it('removes a template that is not ready', async () => {
    db.select
      .mockReturnValueOnce(selectQ([tplRow({ status: 'saving' })]));
    removeTx(tplRow({ status: 'saving' }));
    await expect(service.remove('u1', orgId, 'web-stack')).resolves.toMatchObject({ operation: { id: 'op_1' } });
  });

  it('lists templates of every status', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([tplRow({ status: 'failed' }), tplRow({ status: 'saving' })]));
    await expect(service.list('u1')).resolves.toHaveLength(2);
  });

  it('abandons the reservation even when releasing the generation throws', async () => {
    vi.spyOn(provider, 'captureSnapshot').mockResolvedValue(captureWith('gen-new'));
    vi.spyOn(provider, 'deleteBacking').mockRejectedValue(new Error('store down'));
    const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]]);
    tx.update.mockImplementation(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
    }));
    const remove = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValue({ where: remove });
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(service.save('u1', dockId, 'web-stack')).rejects.toThrow('db down');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not fail a save when releasing the previous generation throws', async () => {
    vi.spyOn(provider, 'captureSnapshot').mockResolvedValue(captureWith('gen-new'));
    vi.spyOn(provider, 'deleteBacking').mockRejectedValue(new Error('store down'));
    const tx = txWith([[tplRow({ storeSnapshotId: 'gen-old' })], []], []);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(service.save('u1', dockId, 'web-stack')).resolves.toMatchObject({ status: 'ready' });
  });

  it('answers not found when the row vanished mid-capture', async () => {
    const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]]);
    const finalize = { update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }) };
    db.transaction.mockImplementationOnce(async (fn: any) => fn(tx)).mockImplementationOnce(async (fn: any) => fn(finalize));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'template_not_found' });
  });

  it('failed re-saves restore the status and clear the save marker', async () => {
    provider.failNextCapture(1);
    const tx = txWith([[tplRow({ savingSince: null })], []], []);
    const restored: Record<string, unknown> = {};
    db.update.mockReturnValue({
      set: (values: Record<string, unknown>) => {
        Object.assign(restored, values);
        return { where: () => Promise.resolve([]) };
      },
    });
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(restored).toMatchObject({ status: 'ready', savingSince: null });
  });

  it('marks a taken-over saving row failed when its save then fails', async () => {
    provider.failNextCapture(1);
    const stale = tplRow({ status: 'saving', updatedAt: new Date(Date.now() - 3_600_000), savingSince: null });
    const tx = txWith([[stale], []], []);
    const restored: Record<string, unknown> = {};
    db.update.mockReturnValue({
      set: (values: Record<string, unknown>) => {
        Object.assign(restored, values);
        return { where: () => Promise.resolve([]) };
      },
    });
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(restored).toMatchObject({ status: 'failed', savingSince: null });
  });

  it('reclaims a stale savingSince on a ready row', async () => {
    const stale = tplRow({ savingSince: new Date(Date.now() - 3_600_000) });
    const tx = txWith([[stale], []], []);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(service.save('u1', dockId, 'web-stack')).resolves.toMatchObject({ status: 'ready' });
  });

  it('finalize after a takeover matches nothing and releases the fresh generation', async () => {
    vi.spyOn(provider, 'captureSnapshot').mockResolvedValue(captureWith('gen-fresh'));
    const backing = vi.spyOn(provider, 'deleteBacking');
    const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]]);
    const finalize = { update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }) };
    db.transaction.mockImplementationOnce(async (fn: any) => fn(tx)).mockImplementationOnce(async (fn: any) => fn(finalize));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(404);
    expect(backing).toHaveBeenCalledWith('gen-fresh');
  });

  it('hides templates that are not ready', async () => {
    db.select
      .mockReturnValueOnce(selectQ([tplRow({ status: 'saving' })]));
    const err = await catchErr(service.get('u1', orgId, 'web-stack'));
    expect(err.status).toBe(404);
  });

  it('freezes the latest snapshot for stopped docks', async () => {
    docks.loadDock.mockResolvedValueOnce({ dock: dockRow({ state: 'archived' }), orgId });
    const tx = txWith(
      [[], [], [{ id: 'snap-9', sizeBytes: 6000 }]], // existing, count, latest
      [],
    );
    tx.insert.mockImplementation((..._args: any[]) => ({
      values: (v: any) => ({ returning: () => Promise.resolve([{ ...tplRow(), ...v }]) }),
    }));
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const saved = await service.save('u1', dockId, 'web-stack');
    expect(saved).toMatchObject({ status: 'ready', snapshotRef: 'snap-9' });
  });

  it('rejects stopped docks without a snapshot', async () => {
    docks.loadDock.mockResolvedValueOnce({ dock: dockRow({ state: 'archived' }), orgId });
    const tx = txWith([[], [], []], []);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const err = await catchErr(service.save('u1', dockId, 'web-stack'));
    expect(err.status).toBe(409);
  });

  it('lists and gets within the caller orgs', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([tplRow()]));
    await expect(service.list('u1')).resolves.toHaveLength(1);
    db.select.mockReturnValueOnce(selectQ([tplRow()]));
    await expect(service.get('u1', orgId, 'web-stack')).resolves.toMatchObject({ name: 'web-stack' });
    expect(orgs.requireMembership).toHaveBeenCalledWith(orgId, 'u1');
    db.select.mockReturnValueOnce(selectQ([]));
    const missing = await catchErr(service.get('u1', orgId, 'nope-missing'));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'template_not_found' });
  });

  it('refuses name lookups in an org the caller is not a member of', async () => {
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException());
    const err = await catchErr(service.get('u1', orgId, 'web-stack'));
    expect(err.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException());
    await catchErr(service.remove('u1', orgId, 'web-stack'));
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('deletes templates with an operation, sparing deployed docks', async () => {
    db.select
      .mockReturnValueOnce(selectQ([tplRow()]));
    removeTx(tplRow());
    const done = await service.remove('u1', orgId, 'web-stack');
    expect(done).toEqual({ operation: { id: 'op_1', status: 'completed' } });
    expect(ops.create).toHaveBeenCalledWith(orgId, 'template', 'tpl-1');
    expect(orgs.requireMembership).toHaveBeenCalledWith(orgId, 'u1', 'admin');
  });

  it('records the captured generation on a newly created template', async () => {
    const capture = vi.spyOn(provider, 'captureSnapshot').mockResolvedValue(captureWith('gen-created'));
    const persisted: Record<string, unknown> = {};
    const tx = txWith([[], [], []], [[tplRow({ status: 'saving' })]], persisted);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await service.save('u1', dockId, 'web-stack');
    // Without the store generation the row owns nothing, so nothing could ever delete it.
    expect(persisted.storeSnapshotId).toBe('gen-created');
    expect(persisted.status).toBe('ready');
    // Each capture creates a generation, so a second one would be orphaned.
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('deletes the generation the template captured, not its row id', async () => {
    db.select
      .mockReturnValueOnce(selectQ([tplRow({ id: 'tpl-1', storeSnapshotId: 'gen-owned', snapshotRef: 'snap-1' })]));
    removeTx(tplRow({ id: 'tpl-1', storeSnapshotId: 'gen-owned', snapshotRef: 'snap-1' }));
    const backing = vi.spyOn(provider, 'deleteBacking');
    const done = await service.remove('u1', orgId, 'web-stack');
    expect(done).toEqual({ operation: { id: 'op_1', status: 'completed' } });
    // The store is keyed by the captured generation: deleting 'tpl-1' drops nothing.
    expect(backing).toHaveBeenCalledTimes(1);
    expect(backing).toHaveBeenCalledWith('gen-owned');
  });

  it('drops nothing from the store when the template never captured a generation', async () => {
    db.select
      .mockReturnValueOnce(selectQ([tplRow({ storeSnapshotId: null, snapshotRef: 'snap-1' })]));
    removeTx(tplRow({ storeSnapshotId: null, snapshotRef: 'snap-1' }));
    const backing = vi.spyOn(provider, 'deleteBacking');
    await service.remove('u1', orgId, 'web-stack');
    // An empty id is the provider's no-op marker; neither the row id nor the
    // generation of the snapshot this template only references may be named.
    expect(backing.mock.calls.flat().filter((id) => id !== '')).toEqual([]);
    expect(removeTxDelete).toHaveBeenCalledTimes(1);
  });

  it('releases the replaced generation when a template is saved again', async () => {
    vi.spyOn(provider, 'captureSnapshot').mockResolvedValue(captureWith('gen-new'));
    const persisted: Record<string, unknown> = {};
    const tx = txWith([[tplRow({ id: 'tpl-1', storeSnapshotId: 'gen-old' })], []], [], persisted);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const backing = vi.spyOn(provider, 'deleteBacking');
    const saved = await service.save('u1', dockId, 'web-stack');
    expect(backing).toHaveBeenCalledTimes(1);
    expect(backing).toHaveBeenCalledWith('gen-old');
    expect(saved).toMatchObject({ storeSnapshotId: 'gen-new', status: 'ready' });
  });

  it('releases an owned generation when a stopped dock re-saves onto a snapshot', async () => {
    docks.loadDock.mockResolvedValueOnce({ dock: dockRow({ state: 'archived' }), orgId });
    const persisted: Record<string, unknown> = {};
    const tx = txWith([[tplRow({ storeSnapshotId: 'gen-old' })], [{ id: 'snap-9', sizeBytes: 7000 }]], [], persisted);
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    const backing = vi.spyOn(provider, 'deleteBacking');
    await service.save('u1', dockId, 'web-stack');
    expect(backing).toHaveBeenCalledWith('gen-old');
    expect(persisted).toMatchObject({ snapshotRef: 'snap-9', storeSnapshotId: null, cpuFamily: null, runtime: null });
  });
});
