import { FakeComputeProvider } from './compute.provider';
import type { Dock } from '../database/schema';

describe('FakeComputeProvider', () => {
  const dock = { id: 'dock-1', name: 'dock-abc123' } as Dock;
  let provider: FakeComputeProvider;

  beforeEach(() => {
    provider = new FakeComputeProvider();
  });

  it('provisions and resumes the same deterministic ip per dock', async () => {
    const a = await provider.provision(dock);
    const b = await provider.resume(dock);
    expect(a.ip).toMatch(/^10\.0\.0\.\d+$/);
    expect(b.ip).toBe(a.ip);
    await expect(provider.branch(dock, { ...dock, id: 'dock-2' })).resolves.toMatchObject({
      ip: expect.stringMatching(/^10\.0\.0\.\d+$/),
    });
  });

  it('tags captures with the runtime of the dock', async () => {
    expect((await provider.captureSnapshot({ ...dock, runtime: 'gvisor' } as Dock, null)).runtime).toBe('gvisor');
  });

  it('captures a marker manifest identifying the dock', async () => {
    const capture = await provider.captureSnapshot(dock, null);
    expect(capture.snapshotId).toMatch(/^fake-snap-\d+$/);
    expect(capture.sizeBytes).toBeGreaterThan(0);
    expect(capture.manifest.files).toHaveLength(1);
    expect(capture.manifest.files[0].path).toBe('home/user/.dock-info.json');
    expect(JSON.parse(capture.manifest.files[0].content)).toMatchObject({ dockId: 'dock-1' });
    const final = await provider.captureFinal(dock, 'snap-1');
    expect(final.sizeBytes).toBe(capture.sizeBytes);
  });

  it('fails injected captures then recovers, without timers', async () => {
    provider.failNextCapture(2);
    await expect(provider.captureSnapshot(dock, null)).rejects.toThrow('fake captureSnapshot failed');
    await expect(provider.captureFinal(dock, null)).rejects.toThrow('fake captureFinal failed');
    await expect(provider.captureSnapshot(dock, null)).resolves.toMatchObject({ sizeBytes: 6000 });
  });

  it('destroys backing as a no-op', async () => {
    await expect(provider.destroyBacking(dock)).resolves.toBeUndefined();
    await expect(provider.deleteBacking('snapshot', 'snap-1')).resolves.toBeUndefined();
  });

  it('answers exec deterministically with an empty successful result', async () => {
    await expect(provider.exec(dock, { script: 'ls', timeoutSeconds: 5, idempotencyToken: 't' })).resolves.toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
    });
  });
});
