import { templateView } from './template-view';
import type { Template } from '../database/schema';

const templateRow = {
  id: 't1',
  organizationId: 'o1',
  name: 'web-stack',
  sourceDockId: 'd1',
  status: 'saving',
  sizeBytes: 42,
  snapshotRef: 'snap-ref-internal',
  storeSnapshotId: 'gen-secret-id',
  cpuFamily: 'zen4',
  runtime: 'microvm',
  baseFingerprint: 'fp-internal',
  savingSince: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as Template;

describe('templateView', () => {
  it('returns exactly the public field set', () => {
    expect(Object.keys(templateView(templateRow)).sort()).toEqual(
      ['id', 'organizationId', 'name', 'sourceDockId', 'status', 'sizeBytes', 'createdAt', 'updatedAt'].sort(),
    );
  });

  it('keeps the state so saving and failed templates are distinguishable', () => {
    expect(templateView(templateRow).status).toBe('saving');
    expect(templateView({ ...templateRow, status: 'failed' }).status).toBe('failed');
  });

  it('never exposes storage, placement or in-flight columns', () => {
    const json = JSON.stringify(templateView({ ...templateRow, extraFutureColumn: 'x' } as Template));
    for (const leaked of [
      'snapshotRef', 'snap-ref-internal', 'storeSnapshotId', 'gen-secret-id', 'cpuFamily', 'baseFingerprint',
      'savingSince', 'runtime', 'extraFutureColumn',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });
});
