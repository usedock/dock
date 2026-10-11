import { dockView } from './dock-view';
import type { Dock } from '../database/schema';

const row = {
  id: 'd1',
  workspaceId: 'ws1',
  name: 'web',
  cpus: 2,
  memoryMiB: 4096,
  diskGiB: 20,
  image: 'ubuntu-24.04',
  runtime: 'microvm',
  state: 'ready',
  ttlSeconds: null,
  environment: 'base',
  envVersionPin: 'v3',
  noEnv: false,
  envBoundAt: new Date(),
  env: { API_KEY: 'super-secret-value' },
  fromTemplate: null,
  ip: '10.0.0.5',
  hostId: 'h1',
  createdBy: 'u1',
  llmTokenHash: 'deadbeef',
  connectors: ['linear'],
  connectorTokenHash: 'cafef00d',
  setupStatus: 'ready',
  setupError: null,
  lastSnapshotAt: null,
  diskBytes: 1,
  liveSince: new Date(),
  billingPausedAt: null,
  stateChangedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as Dock;

describe('dockView', () => {
  it('returns exactly the public field set', () => {
    expect(Object.keys(dockView(row)).sort()).toEqual(
      [
        'id', 'workspaceId', 'name', 'image', 'cpus', 'memoryMiB', 'diskGiB', 'runtime', 'persistentPaths', 'state',
        'ttlSeconds', 'environment', 'connectors', 'fromTemplate', 'ip', 'hostId', 'billingPausedAt', 'setupStatus', 'setupError',
        'lastSnapshotAt', 'stateChangedAt', 'createdAt', 'updatedAt',
      ].sort(),
    );
  });

  it('never exposes env values, token hashes or other internal columns', () => {
    const json = JSON.stringify(dockView({ ...row, extraFutureColumn: 'x' } as Dock));
    for (const leaked of ['super-secret-value', 'deadbeef', 'cafef00d', 'connectorTokenHash', 'llmTokenHash', 'env"', 'envVersionPin', 'createdBy', 'extraFutureColumn']) {
      expect(json).not.toContain(leaked);
    }
  });

  it('lists connector names', () => {
    expect(dockView(row).connectors).toEqual(['linear']);
  });

  it('derives persistentPaths from the runtime', () => {
    expect(dockView(row).persistentPaths).toEqual(['/']);
    expect(dockView({ ...row, runtime: 'gvisor' }).persistentPaths).toEqual(['/home/user/work']);
  });
});
