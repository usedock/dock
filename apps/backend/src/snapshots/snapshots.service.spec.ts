import { HttpException } from '@nestjs/common';
import { DockNotFoundException } from '../docks/dock-errors';
import { EnvironmentSecretsAdminOnlyException } from '../environments/environments.service';
import { DockletException } from '../runtime/docklet.client';
import { SnapshotNotFoundException, SnapshotsService } from './snapshots.service';
import { vi, type Mock } from 'vitest';

describe('SnapshotsService', () => {
  let db: any;
  let docks: any;
  let ops: any;
  let provider: any;
  let docklets: Mock;
  let docklet: any;
  let service: SnapshotsService;

  const dockId = '33333333-3333-4333-8333-333333333333';
  const snapId = '44444444-4444-4444-8444-444444444444';
  const manifest = { files: [{ path: 'home/user/.dock-info.json', size: 20, content: '{"a":1}' }] };
  const snapRow = (overrides: Record<string, unknown> = {}) => ({
    id: snapId,
    dockId,
    status: 'completed',
    sizeBytes: 6000,
    parentId: null,
    manifest,
    storeSnapshotId: null,
    cpuFamily: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });

  const selectRows = (rows: any[]) => {
    const settled = Promise.resolve(rows);
    const where = () => ({
      orderBy: () => ({ limit: () => settled }),
      limit: () => settled,
      then: settled.then.bind(settled),
    });
    return { from: () => ({ where }) };
  };
  const deleteRows = () => ({ where: () => Promise.resolve([]) });

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
    vi.clearAllMocks();
    const loaded = { dock: { id: dockId, hostId: null }, orgId: 'org-1' };
    docks = { loadDock: vi.fn().mockResolvedValue(loaded), loadReadableDock: vi.fn().mockResolvedValue(loaded) };
    ops = {
      create: vi.fn().mockResolvedValue({ id: 'op_1', status: 'pending' }),
      complete: vi.fn().mockResolvedValue({ id: 'op_1', status: 'completed' }),
    };
    provider = { deleteBacking: vi.fn().mockResolvedValue(undefined) };
    docklet = { generationTree: vi.fn(), generationFile: vi.fn() };
    docklets = vi.fn().mockResolvedValue(docklet);
    service = new SnapshotsService(db as never, docks as never, ops as never, provider as never, docklets as never);
  });

  it('pages across docks with opaque cursors', async () => {
    const first = snapRow();
    const second = snapRow({ id: '55555555-5555-4555-8555-555555555555', createdAt: new Date('2026-08-01T00:00:00.000Z') });
    db.select
      .mockReturnValueOnce(selectRows([{ organizationId: 'org-1' }]))
      .mockReturnValueOnce(selectRows([{ id: 'ws-1' }]))
      .mockReturnValueOnce(selectRows([{ id: dockId }]))
      .mockReturnValueOnce(selectRows([first, second]));
    const page1 = await service.listAll('u1', undefined, 1);
    expect(page1.snapshots).toHaveLength(1);
    expect(typeof page1.nextCursor).toBe('string');
    db.select
      .mockReturnValueOnce(selectRows([{ organizationId: 'org-1' }]))
      .mockReturnValueOnce(selectRows([{ id: 'ws-1' }]))
      .mockReturnValueOnce(selectRows([{ id: dockId }]))
      .mockReturnValueOnce(selectRows([second]));
    const page2 = await service.listAll('u1', page1.nextCursor as string, 1);
    expect(page2.snapshots).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects bad cursors and limits, and returns empty for strangers', async () => {
    const badCursor = await catchErr(service.listAll('u1', 'not-a-cursor'));
    expect(badCursor.status).toBe(400);
    const badLimit = await catchErr(service.listAll('u1', undefined, 0));
    expect(badLimit.status).toBe(400);
    db.select.mockReturnValueOnce(selectRows([]));
    await expect(service.listAll('stranger')).resolves.toEqual({ snapshots: [], nextCursor: null });
  });

  it('returns null latest when a dock has no snapshots', async () => {
    db.select.mockReturnValueOnce(selectRows([]));
    await expect(service.latest('u1', dockId)).resolves.toBeNull();
  });

  it('hides non-completed and foreign snapshots', async () => {
    db.select.mockReturnValueOnce(selectRows([snapRow({ status: 'saving' })]));
    const saving = await catchErr(service.tree('u1', snapId));
    expect(saving.body).toMatchObject({ code: 'snapshot_not_found' });
    db.select.mockReturnValueOnce(selectRows([snapRow()]));
    docks.loadReadableDock.mockRejectedValueOnce(new DockNotFoundException());
    const foreign = await catchErr(service.tree('stranger', snapId));
    expect(foreign.body).toMatchObject({ code: 'dock_not_found' });
    expect(new SnapshotNotFoundException().getStatus()).toBe(404);
  });

  it('refuses tree, file and download reads of a dock holding admins-only secrets', async () => {
    for (const call of [() => service.tree('u1', snapId), () => service.file('u1', snapId, 'home/user/.dock/env.sh'), () => service.download('u1', snapId)]) {
      db.select.mockReturnValueOnce(selectRows([snapRow()]));
      docks.loadReadableDock.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
      await expect(call()).rejects.toMatchObject({ response: { code: 'environment_secrets_admin_only' } });
    }
  });

  it('lists the tree and streams one file', async () => {
    db.select.mockReturnValueOnce(selectRows([snapRow()]));
    await expect(service.tree('u1', snapId)).resolves.toEqual({
      snapshotId: snapId,
      files: [{ path: 'home/user/.dock-info.json', size: 20 }],
    });
    db.select.mockReturnValueOnce(selectRows([snapRow()]));
    await expect(service.file('u1', snapId, 'home/user/.dock-info.json')).resolves.toMatchObject({
      filename: '.dock-info.json',
      content: '{"a":1}',
    });
    db.select.mockReturnValueOnce(selectRows([snapRow()]));
    const missing = await catchErr(service.file('u1', snapId, 'home/user/nope.txt'));
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain('home/user/nope.txt');
  });

  it('describes reconstruction through the files endpoint', async () => {
    db.select.mockReturnValueOnce(selectRows([snapRow()]));
    const dl = await service.download('u1', snapId);
    expect(dl.files[0].url).toContain(`/v1/snapshots/${snapId}/files?path=`);
  });

  it('proxies tree reads from the snapshot store', async () => {
    const storeFiles = [{ path: 'home/user/app.txt', size: 11 }];
    docklet.generationTree.mockResolvedValueOnce(storeFiles);
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    await expect(service.tree('u1', snapId)).resolves.toEqual({ snapshotId: snapId, files: storeFiles });
    expect(docklet.generationTree).toHaveBeenCalledWith('gen-1');
  });

  it('falls back to the manifest when the store is unreachable', async () => {
    docklet.generationTree.mockRejectedValueOnce(new DockletException('docklet_unreachable', 'down'));
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    await expect(service.tree('u1', snapId)).resolves.toEqual({
      snapshotId: snapId,
      files: [{ path: 'home/user/.dock-info.json', size: 20 }],
    });
  });

  it('never contacts the store for legacy rows', async () => {
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: null })]));
    await service.tree('u1', snapId);
    expect(docklet.generationTree).not.toHaveBeenCalled();
  });

  it('streams file content from the snapshot store', async () => {
    docklet.generationFile.mockResolvedValueOnce({ content: 'hello', size: 5 });
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    await expect(service.file('u1', snapId, 'home/user/app.txt')).resolves.toEqual({
      filename: 'app.txt',
      size: 5,
      content: 'hello',
    });
    expect(docklet.generationFile).toHaveBeenCalledWith('gen-1', 'home/user/app.txt');
  });

  it('reads generation content through the owning host', async () => {
    const remote = { generationFile: vi.fn().mockResolvedValueOnce({ content: 'remote', size: 6 }) };
    docklets.mockImplementation(async (id: string | null) => (id === 'h2' ? remote : docklet));
    docks.loadReadableDock.mockResolvedValueOnce({ dock: { id: dockId, hostId: 'h2' }, orgId: 'org-1' });
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-9' })]));
    await expect(service.file('u1', snapId, 'home/user/app.txt')).resolves.toEqual({
      filename: 'app.txt',
      size: 6,
      content: 'remote',
    });
    expect(docklets).toHaveBeenCalledWith('h2');
    expect(remote.generationFile).toHaveBeenCalledWith('gen-9', 'home/user/app.txt');
    expect(docklet.generationFile).not.toHaveBeenCalled();
  });

  it('keeps the snapshot_not_found contract for unknown store paths', async () => {
    docklet.generationFile.mockRejectedValueOnce(new DockletException('generation_not_found', 'nope'));
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    const missing = await catchErr(service.file('u1', snapId, 'home/user/nope.txt'));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'snapshot_not_found' });
  });

  it.each([
    ['not_a_regular_file', 422],
    ['file_too_large', 413],
  ])('surfaces docklet %s as %i instead of the manifest', async (code, status) => {
    docklet.generationFile.mockRejectedValueOnce(new DockletException(code, 'refused'));
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    const err = await catchErr(service.file('u1', snapId, 'home/user/app.txt'));
    expect(err.status).toBe(status);
    expect(err.body).toMatchObject({ code });
  });

  it('keeps the manifest fallback when the docklet is unreachable', async () => {
    docklet.generationFile.mockRejectedValueOnce(new DockletException('docklet_unreachable', 'down'));
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    const err = await catchErr(service.file('u1', snapId, 'home/user/nope.txt'));
    expect(err.body).toMatchObject({ code: 'snapshot_not_found' });
  });

  it('rejects missing and in-use snapshot deletes', async () => {
    db.select.mockReturnValueOnce(selectRows([]));
    const missing = await catchErr(service.remove('u1', snapId, snapId));
    expect(missing.body).toMatchObject({ code: 'snapshot_not_found' });

    db.select
      .mockReturnValueOnce(selectRows([snapRow()]))
      .mockReturnValueOnce(selectRows([{ id: 'child-1' }]));
    const used = await catchErr(service.remove('u1', snapId, snapId));
    expect(used.status).toBe(409);
    expect(used.body).toMatchObject({ code: 'snapshot_in_use' });
  });

  it('refuses to delete a snapshot a template saved', async () => {
    db.select
      .mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]))
      .mockReturnValueOnce(selectRows([]))
      .mockReturnValueOnce(selectRows([{ name: 'web-stack' }]));
    const err = await catchErr(service.remove('u1', snapId, snapId));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'snapshot_in_use', message: expect.stringContaining('web-stack') });
    expect(provider.deleteBacking).not.toHaveBeenCalled();
  });

  it('treats a null store tree as empty', async () => {
    docklet.generationTree.mockResolvedValueOnce(null);
    db.select.mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]));
    await expect(service.tree('u1', snapId)).resolves.toEqual({ snapshotId: snapId, files: [] });
  });

  it('requires confirmation for deletes', async () => {
    db.select.mockReturnValueOnce(selectRows([snapRow()]));
    const err = await catchErr(service.remove('u1', snapId, 'wrong'));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'confirm_required' });
  });

  it('deletes the stored generation before dropping the row', async () => {
    db.select
      .mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: 'gen-1' })]))
      .mockReturnValueOnce(selectRows([])) // dependents
      .mockReturnValueOnce(selectRows([])); // templates
    db.delete.mockReturnValueOnce(deleteRows());
    const done = await service.remove('u1', snapId, snapId);
    expect(done).toEqual({ operation: { id: 'op_1', status: 'completed' } });
    expect(db.delete).toHaveBeenCalledTimes(1);
    // The store is keyed by the generation the docklet returned, not the row id.
    expect(provider.deleteBacking).toHaveBeenCalledWith('gen-1');
  });

  it('skips the store call when a snapshot never recorded a generation', async () => {
    db.select
      .mockReturnValueOnce(selectRows([snapRow({ storeSnapshotId: null })]))
      .mockReturnValueOnce(selectRows([])) // dependents
      .mockReturnValueOnce(selectRows([])); // templates
    db.delete.mockReturnValueOnce(deleteRows());
    await service.remove('u1', snapId, snapId);
    // Nothing to delete in the store, and the row must still go away.
    expect(provider.deleteBacking).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});
