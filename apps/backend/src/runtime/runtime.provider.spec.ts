import { RestateComputeProvider, finalCaptureToken } from './runtime.provider';
import { vi } from 'vitest';

const dockRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  cpus: 2,
  memoryMiB: 4096,
  diskGiB: 20,
  image: 'ubuntu-24.04',
  runtime: 'microvm',
  ip: '10.1.2.3',
  ...overrides,
});

const factoryFor = (docklet: unknown) => vi.fn().mockResolvedValue(docklet);

describe('RestateComputeProvider', () => {
  it('provisions through the docklet and maps the handle', async () => {
    const docklet = { provision: vi.fn().mockResolvedValue({ ip: '10.9.9.9', hostId: 'h1' }) };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    await expect(provider.provision(dockRow() as never)).resolves.toEqual({ ip: '10.9.9.9', hostId: 'h1' });
    expect(docklets).toHaveBeenCalledWith(null);
    const payload = docklet.provision.mock.calls[0][0];
    expect(payload).toMatchObject({ dockId: 'd1', resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, image: 'ubuntu-24.04' });
    expect(Object.keys(JSON.parse(JSON.stringify(payload))).sort()).toEqual(['dockId', 'execAgent', 'idempotencyToken', 'image', 'resources']);
  });

  it('routes targeted provisions through the placed host', async () => {
    const docklet = { provision: vi.fn().mockResolvedValue({ ip: '10.9.9.9', hostId: 'h9' }) };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    await expect(
      provider.provision(dockRow() as never, { snapshotId: null, hostId: 'h9' }),
    ).resolves.toEqual({ ip: '10.9.9.9', hostId: 'h9' });
    expect(docklets).toHaveBeenCalledWith('h9');
  });

  it('boots every provision and branch with the exec agent but leaves egress open', async () => {
    const docklet = { provision: vi.fn().mockResolvedValue({ ip: '10.9.9.9', hostId: 'h1' }) };
    const provider = new RestateComputeProvider(factoryFor(docklet) as never);
    await provider.provision(dockRow() as never, { hostId: 'h1' });
    await provider.branch(dockRow() as never, dockRow({ id: 'd2' }) as never, { hostId: 'h1', snapshotId: 's1' });
    for (const [call] of docklet.provision.mock.calls) {
      expect(call).toMatchObject({ execAgent: true });
      expect(call).not.toHaveProperty('egressAllow');
    }
  });

  it('runs exec through the owning host with the caller token and maps flags', async () => {
    const docklet = {
      fastRunExec: vi.fn().mockResolvedValue({ runtimeId: 'd1', exitCode: 2, stdout: 'o', stderr: 'e', truncated: true }),
    };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    await expect(
      provider.exec(dockRow({ hostId: 'h4' }) as never, { script: 'ls', timeoutSeconds: 5, env: { A: '1' }, idempotencyToken: 'exec:d1:t' }),
    ).resolves.toEqual({ exitCode: 2, stdout: 'o', stderr: 'e', truncated: true, timedOut: false });
    expect(docklets).toHaveBeenCalledWith('h4');
    expect(docklet.fastRunExec).toHaveBeenCalledWith({ runtimeId: 'd1', script: 'ls', timeoutSeconds: 5, env: { A: '1' }, idempotencyToken: 'exec:d1:t' });
    await provider.exec(dockRow({ hostId: 'h4' }) as never, { script: 'ls', timeoutSeconds: 5, env: {}, idempotencyToken: 'x' });
    expect(docklet.fastRunExec.mock.calls[1][0]).not.toHaveProperty('env');
  });

  it('forwards an egress allowlist only when non-empty', async () => {
    const docklet = { provision: vi.fn().mockResolvedValue({ ip: '10.9.9.9', hostId: 'h1' }) };
    const provider = new RestateComputeProvider(factoryFor(docklet) as never);
    await provider.provision(dockRow() as never, { hostId: 'h1', egressAllow: ['github.com'] });
    await provider.provision(dockRow() as never, { hostId: 'h1', egressAllow: [] });
    expect(docklet.provision.mock.calls[0][0]).toMatchObject({ execAgent: true, egressAllow: ['github.com'] });
    expect(docklet.provision.mock.calls[1][0]).not.toHaveProperty('egressAllow');
  });

  it('rejects a docklet answering for a different host than targeted', async () => {
    const docklet = { provision: vi.fn().mockResolvedValue({ ip: '10.9.9.9', hostId: 'rogue' }) };
    const provider = new RestateComputeProvider(factoryFor(docklet) as never);
    await expect(provider.provision(dockRow() as never, { hostId: 'h1' })).rejects.toMatchObject({
      code: 'host_mismatch',
    });
  });

  it('captures diff snapshots inline and full snapshots on final', async () => {
    const docklet = {
      snapshotCreate: vi.fn().mockResolvedValue({ snapshotId: 's1', sizeBytes: 42, cpuFamily: 'icelake' }),
    };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    const inline = await provider.captureSnapshot(dockRow({ hostId: 'h1' }) as never, null);
    const final = await provider.captureFinal(dockRow({ hostId: 'h1' }) as never, 'parent');
    expect(docklets).toHaveBeenCalledWith('h1');
    expect(docklet.snapshotCreate).toHaveBeenNthCalledWith(1, 'd1', null, 'diff', true);
    expect(docklet.snapshotCreate).toHaveBeenNthCalledWith(2, 'd1', 'parent', 'full', false, false, 'final:d1:parent');
    expect(inline.snapshotId).toBe('s1');
    expect(inline.sizeBytes).toBe(42);
    expect(inline.runtime).toBe('microvm');
    expect(JSON.stringify(final.manifest)).toContain('icelake');
  });

  it('carries the base fingerprint a microVM generation reports, dropping malformed values', async () => {
    const fp = '0123456789abcdef'.repeat(4);
    const docklet = {
      snapshotCreate: vi
        .fn()
        .mockResolvedValueOnce({ snapshotId: 's1', sizeBytes: 1, cpuFamily: 'icelake', baseFingerprint: fp })
        .mockResolvedValueOnce({ snapshotId: 's2', sizeBytes: 1, cpuFamily: 'icelake', baseFingerprint: '../etc' })
        .mockResolvedValueOnce({ snapshotId: 's3', sizeBytes: 1, cpuFamily: 'icelake' }),
    };
    const provider = new RestateComputeProvider(factoryFor(docklet) as never);
    expect((await provider.captureSnapshot(dockRow({ hostId: 'h1' }) as never, null)).baseFingerprint).toBe(fp);
    expect((await provider.captureFinal(dockRow({ hostId: 'h1' }) as never, null)).baseFingerprint).toBeNull();
    expect((await provider.captureSnapshot(dockRow({ hostId: 'h1' }) as never, null)).baseFingerprint).toBeNull();
  });

  it('tags captures with the runtime of the dock', async () => {
    const docklet = {
      snapshotCreate: vi.fn().mockResolvedValue({ snapshotId: 's2', sizeBytes: 7, cpuFamily: 'icelake' }),
    };
    const provider = new RestateComputeProvider(factoryFor(docklet) as never);
    const capture = await provider.captureSnapshot(dockRow({ hostId: 'h1', runtime: 'gvisor' }) as never, null);
    expect(capture.runtime).toBe('gvisor');
    expect(capture.kernelRelease).toBeNull();
  });

  it('forks the captured generation on branch', async () => {
    const docklet = {
      provision: vi.fn().mockResolvedValue({ ip: '10.9.9.11', hostId: 'h1' }),
    };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    await expect(
      provider.branch(dockRow() as never, dockRow({ id: 'd2' }) as never, { snapshotId: 's9', hostId: 'h1' }),
    ).resolves.toEqual({ ip: '10.9.9.11', hostId: 'h1' });
    expect(docklets).toHaveBeenCalledWith('h1');
    expect(docklet.provision).toHaveBeenCalledWith(expect.objectContaining({ dockId: 'd2', snapshotId: 's9' }));
  });

  it('deletes a dock that never placed without a host lookup', async () => {
    const docklet = { destroy: vi.fn() };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    // A dock that never reached a host has nothing to fence; failing here
    // would leave such rows undeletable forever.
    await expect(provider.destroyBacking(dockRow({ hostId: null }) as never)).resolves.toBeUndefined();
    expect(docklets).not.toHaveBeenCalled();
    expect(docklet.destroy).not.toHaveBeenCalled();
  });

  it('resumes the explicit snapshot and destroys backing on delete', async () => {
    const docklet = {
      snapshotLoad: vi.fn().mockResolvedValue({ ip: '10.9.9.10', hostId: 'h1' }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const docklets = factoryFor(docklet);
    const provider = new RestateComputeProvider(docklets as never);
    await expect(provider.resume(dockRow({ hostId: 'h1' }) as never, { snapshotId: 'gen-9' })).resolves.toEqual({ ip: '10.9.9.10', hostId: 'h1' });
    await provider.destroyBacking(dockRow({ hostId: 'h1' }) as never);
    expect(docklets).toHaveBeenCalledWith('h1');
    expect(docklet.snapshotLoad).toHaveBeenCalledWith('d1', { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, 'ubuntu-24.04', 'gen-9', true);
    expect(docklet.destroy).toHaveBeenCalledWith('d1');
  });

  it('refuses to resume without a stored snapshot id', async () => {
    const docklets = factoryFor({ snapshotLoad: vi.fn() });
    const provider = new RestateComputeProvider(docklets as never);
    await expect(provider.resume(dockRow({ hostId: 'h1' }) as never, { snapshotId: null })).rejects.toThrow(/no stored snapshot/);
    expect(docklets).not.toHaveBeenCalled();
  });

  it('keys final captures per archiving episode', async () => {
    expect(finalCaptureToken('d1', null)).toBe('final:d1:root');
    expect(finalCaptureToken('d1', 's9')).toBe('final:d1:s9');
    expect(finalCaptureToken('d1', 's9')).toBe(finalCaptureToken('d1', 's9'));
    expect(finalCaptureToken('d1', 's9')).not.toBe(finalCaptureToken('d1', 's10'));
  });
});
