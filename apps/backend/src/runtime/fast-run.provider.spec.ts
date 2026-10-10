import { DockletFastRunProvider } from './fast-run.provider';
import { vi } from 'vitest';

describe('DockletFastRunProvider', () => {
  it('creates on the placed host and addresses every later call by host, surviving restarts', async () => {
    const docklet = {
      fastRunCreate: vi.fn().mockResolvedValue({
        runtimeId: 'fast-1',
        hostId: 'host-1',
        ip: '10.0.0.9',
        capabilities: { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: { docker: true } },
      }),
      fastRunExec: vi.fn().mockResolvedValue({ runtimeId: 'fast-1', exitCode: 0, stdout: 'ok', stderr: '' }),
      fastRunRead: vi.fn().mockResolvedValue({ runtimeId: 'fast-1', path: '/run/dock-fast/RESULT.json', content: Buffer.from('{}').toString('base64'), sizeBytes: 2 }),
      fastRunTerminate: vi.fn().mockResolvedValue({ runtimeId: 'fast-1' }),
    };
    const factory = vi.fn().mockResolvedValue(docklet);
    const provider = new DockletFastRunProvider(factory as never);
    const handle = await provider.create({
      runtimeId: 'fast-1',
      hostId: 'host-1',
      resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 },
      image: 'ubuntu-24.04',
      capabilities: { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: {} },
    });
    expect(handle.ip).toBe('10.0.0.9');
    expect(docklet.fastRunCreate.mock.calls[0][0]).not.toHaveProperty('egressAllow');
    expect(docklet.fastRunCreate.mock.calls[0][0]).toMatchObject({ resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, image: 'ubuntu-24.04' });
    expect(Object.keys(docklet.fastRunCreate.mock.calls[0][0]).sort()).toEqual(['capabilities', 'guestToken', 'idempotencyToken', 'image', 'resources', 'runtimeId']);
    await provider.create({
      runtimeId: 'fast-1',
      hostId: 'host-1',
      resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 },
      image: 'ubuntu-24.04',
      capabilities: { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: {} },
      egressAllow: ['github.com'],
    });
    expect(docklet.fastRunCreate.mock.calls[1][0]).toMatchObject({ egressAllow: ['github.com'] });
    const restarted = new DockletFastRunProvider(factory as never);
    const ref = { hostId: 'host-1', runtimeId: 'fast-1' };
    await expect(restarted.exec(ref, 'echo ok', 30, 'exec-1', { A: 'b' })).resolves.toMatchObject({ exitCode: 0 });
    expect(docklet.fastRunExec).toHaveBeenCalledWith({ runtimeId: 'fast-1', script: 'echo ok', timeoutSeconds: 30, env: { A: 'b' }, idempotencyToken: 'exec-1' });
    await expect(restarted.collectArtifacts(ref, ['/run/dock-fast/RESULT.json'], 'a')).resolves.toEqual({ '/run/dock-fast/RESULT.json': '{}' });
    await expect(restarted.terminate(ref, 'terminate-1')).resolves.toBeUndefined();
    expect(docklet.fastRunTerminate).toHaveBeenCalledWith('fast-1', 'terminate-1');
    expect(factory.mock.calls.every(([hostId]) => hostId === 'host-1')).toBe(true);
  });

  it('re-reads once under a fresh token when a read replay is not retained', async () => {
    const notRetained = Object.assign(new Error('already executed, result not retained'), { code: 'result_not_retained' });
    const docklet = { fastRunRead: vi.fn().mockRejectedValueOnce(notRetained).mockResolvedValueOnce({ content: Buffer.from('log').toString('base64') }) };
    const provider = new DockletFastRunProvider(vi.fn().mockResolvedValue(docklet) as never);
    await expect(provider.collectArtifacts({ hostId: 'h', runtimeId: 'r' }, ['/a'], 'p')).resolves.toEqual({ '/a': 'log' });
    expect(docklet.fastRunRead.mock.calls.map(([req]) => req.idempotencyToken)).toEqual(['p:read:0', 'p:read:0:r1']);
  });

  it('skips missing artifacts and surfaces cleanup failures for retry', async () => {
    const docklet = {
      fastRunRead: vi.fn().mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce({ content: Buffer.from('log').toString('base64') }),
      fastRunTerminate: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ runtimeId: 'fast-2' }),
    };
    const provider = new DockletFastRunProvider(vi.fn().mockResolvedValue(docklet) as never);
    const ref = { hostId: 'h', runtimeId: 'fast-2' };
    await expect(provider.collectArtifacts(ref, ['/a', '/b'], 'p')).resolves.toEqual({ '/b': 'log' });
    await expect(provider.terminate(ref, 'term-1')).rejects.toThrow('down');
    await expect(provider.terminate(ref, 'term-2')).resolves.toBeUndefined();
  });

  it('fails closed on unsupported capability contract versions', async () => {
    const docklet = { fastRunCreate: vi.fn() };
    const provider = new DockletFastRunProvider(vi.fn().mockResolvedValue(docklet) as never);
    await expect(
      provider.create({
        runtimeId: 'fast-3',
        resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 },
        image: 'ubuntu-24.04',
        capabilities: { version: 2, target: 'fast', profile: 'warm-microvm', capabilities: {} },
      }),
    ).rejects.toThrow('Unsupported capability version');
    expect(docklet.fastRunCreate).not.toHaveBeenCalled();
  });
  it('rejects docklet capability drift and missing requested capabilities', async () => {
    const base = { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: {} };
    const drifted = { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: { sshTakeover: true } };
    const persistent = { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: { persistentState: true } };
    const partial = { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: {} };
    for (const caps of [drifted, persistent]) {
      const docklet = { fastRunCreate: vi.fn().mockResolvedValue({ runtimeId: 'fast-x', hostId: 'h', ip: '10.0.0.1', capabilities: caps }) };
      const provider = new DockletFastRunProvider(vi.fn().mockResolvedValue(docklet) as never);
      await expect(
        provider.create({ runtimeId: 'fast-x', resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, image: 'ubuntu-24.04', capabilities: base }),
      ).rejects.toThrow('capability_unavailable');
    }
    const docklet = { fastRunCreate: vi.fn().mockResolvedValue({ runtimeId: 'fast-y', hostId: 'h', ip: '10.0.0.1', capabilities: partial }) };
    const provider = new DockletFastRunProvider(vi.fn().mockResolvedValue(docklet) as never);
    await expect(
      provider.create({
        runtimeId: 'fast-y',
        resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 },
        image: 'ubuntu-24.04',
        capabilities: { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: { docker: true } },
      }),
    ).rejects.toThrow('capability_unavailable');
  });
});
