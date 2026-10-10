import type { Response } from 'express';
import { SnapshotsController } from './snapshots.controller';
import { vi, type Mock } from 'vitest';

describe('SnapshotsController', () => {
  let snapshots: {
    listAll: Mock;
    listByDock: Mock;
    latest: Mock;
    tree: Mock;
    file: Mock;
    download: Mock;
    remove: Mock;
  };
  let controller: SnapshotsController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };

  beforeEach(() => {
    snapshots = {
      listAll: vi.fn(),
      listByDock: vi.fn(),
      latest: vi.fn(),
      tree: vi.fn(),
      file: vi.fn(),
      download: vi.fn(),
      remove: vi.fn(),
    };
    controller = new SnapshotsController(snapshots as never);
  });

  it('lists with cursor and limit passthrough', async () => {
    snapshots.listAll.mockResolvedValue({ snapshots: [], nextCursor: null });
    await expect(controller.list(user, { cursor: 'c', limit: 10 })).resolves.toEqual({ snapshots: [], nextCursor: null });
    expect(snapshots.listAll).toHaveBeenCalledWith('u1', 'c', 10);
  });

  it('reads latest and tree per dock and snapshot', async () => {
    snapshots.latest.mockResolvedValue(null);
    snapshots.tree.mockResolvedValue({ snapshotId: 's1', files: [] });
    await expect(controller.latest(user, 'd1')).resolves.toBeNull();
    await expect(controller.tree(user, 's1')).resolves.toMatchObject({ snapshotId: 's1' });
  });

  it('streams file bytes outside the envelope', async () => {
    snapshots.file.mockResolvedValue({ filename: 'f', size: 3, content: 'abc' });
    const res = { type: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as Response;
    await controller.files(user, 's1', 'home/user/f', res);
    expect(snapshots.file).toHaveBeenCalledWith('u1', 's1', 'home/user/f');
    expect(res.type).toHaveBeenCalledWith('application/octet-stream');
    expect(res.send).toHaveBeenCalledWith('abc');
  });

  it('deletes with the confirm header', async () => {
    snapshots.remove.mockResolvedValue({ operation: { id: 'op_1' } });
    await expect(controller.remove(user, 's1', 's1')).resolves.toEqual({ operation: { id: 'op_1' } });
    expect(snapshots.remove).toHaveBeenCalledWith('u1', 's1', 's1');
  });
});
