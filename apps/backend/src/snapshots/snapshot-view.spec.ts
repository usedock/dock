import { snapshotView } from './snapshot-view';
import type { Snapshot } from '../database/schema';

const snapshotRow = {
  id: 's1',
  dockId: 'd1',
  status: 'completed',
  sizeBytes: 42,
  parentId: 's0',
  manifest: { files: [{ path: 'work/.env', size: 9, content: 'top-secret' }] },
  storeSnapshotId: 'gen-secret-id',
  cpuFamily: 'zen4',
  runtime: 'microvm',
  kernelRelease: '6.1.0-internal',
  baseFingerprint: 'fp-internal',
  createdAt: new Date(),
} as Snapshot;

describe('snapshotView', () => {
  it('returns exactly the public field set', () => {
    expect(Object.keys(snapshotView(snapshotRow)).sort()).toEqual(
      ['id', 'dockId', 'status', 'sizeBytes', 'runtime', 'createdAt'].sort(),
    );
  });

  it('never exposes the manifest or internal storage and placement columns', () => {
    const json = JSON.stringify(snapshotView({ ...snapshotRow, extraFutureColumn: 'x' } as Snapshot));
    for (const leaked of [
      'top-secret', 'manifest', 'storeSnapshotId', 'gen-secret-id', 'cpuFamily', 'kernelRelease', 'baseFingerprint',
      'parentId', 'extraFutureColumn',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });
});
