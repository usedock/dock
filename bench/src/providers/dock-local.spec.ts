import { describe, expect, it } from 'vitest';
import { DockLocalProvider, lastLine, type CliResult } from './dock-local.ts';

const done = (stdout = '', code = 0, stderr = ''): CliResult => ({ code, stdout, stderr });

function fake(handler: (args: string[]) => CliResult) {
  const calls: string[][] = [];
  const provider = new DockLocalProvider({
    run: async (args) => {
      calls.push(args);
      return handler(args);
    },
  });
  return { provider, calls };
}

describe('DockLocalProvider', () => {
  it('creates with the local default size and returns the dock id', async () => {
    const { provider, calls } = fake(() => done(JSON.stringify({ id: 'dk_1', runtime: 'qemu' })));
    expect(await provider.create()).toEqual({ id: 'dk_1' });
    expect(calls[0].slice(0, 1)).toEqual(['new']);
    expect(calls[0]).toEqual(expect.arrayContaining(['--cpus', '2', '--memory', '2048mb', '--disk', '10gb', '--json']));
    expect((await provider.info()).runtime).toBe('qemu');
  });

  it('removes a dock left behind by a failed create', async () => {
    const { provider, calls } = fake((args) => {
      if (args[0] === 'new') return done('', 1, 'error: timeout');
      if (args[0] === 'ls') return done(JSON.stringify([{ id: 'dk_9', name: calls[0][1] }, { id: 'dk_other', name: 'x' }]));
      return done('{}');
    });
    await expect(provider.create()).rejects.toThrow(/dock new exited 1: error: timeout/);
    expect(calls.filter((c) => c[0] === 'rm').map((c) => c[1])).toEqual(['dk_9']);
  });

  it('reads the exec result even when the command exits non-zero', async () => {
    const { provider, calls } = fake(() => done(JSON.stringify({ exitCode: 3, stdout: 'x' }), 3));
    expect(await provider.exec({ id: 'dk_1' }, 'false')).toEqual({ exitCode: 3, stdout: 'x' });
    expect(calls[0]).toEqual(['exec', 'dk_1', '--json', '--', 'false']);
  });

  it('fails exec when the CLI printed no result', async () => {
    const { provider } = fake(() => done('', 1, 'error: dock_not_ready: not ready'));
    await expect(provider.exec({ id: 'dk_1' }, 'true')).rejects.toThrow(/dock_not_ready/);
  });

  it('branches into an array, or a single object for one copy', async () => {
    const many = fake(() => done(JSON.stringify([{ id: 'a' }, { id: 'b' }])));
    expect(await many.provider.branch({ id: 's' }, 2)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(many.calls[0]).toEqual(['branch', 's', '--count', '2', '--json']);
    const one = fake(() => done(JSON.stringify({ id: 'a' })));
    expect(await one.provider.branch({ id: 's' }, 1)).toEqual([{ id: 'a' }]);
  });

  it('destroys the copies a failed branch reported', async () => {
    const { provider, calls } = fake((args) =>
      args[0] === 'branch' ? done(JSON.stringify([{ id: 'a' }]), 1, 'error: out of memory') : done('{}'),
    );
    await expect(provider.branch({ id: 's' }, 3)).rejects.toThrow(/out of memory/);
    expect(calls.filter((c) => c[0] === 'rm').map((c) => c[1])).toEqual(['a']);
  });

  it('treats removing a missing dock as done but surfaces other failures', async () => {
    const gone = fake(() => done('', 1, 'error: dock_not_found: no such dock'));
    await expect(gone.provider.destroy({ id: 'x' })).resolves.toBeUndefined();
    const bad = fake(() => done('', 1, 'error: boom'));
    await expect(bad.provider.destroy({ id: 'x' })).rejects.toThrow(/boom/);
  });
  it('reduces CLI stderr to its error line without terminal escapes', () => {
    const noisy = '\x1b[0;32m  OK  \x1b[0m Started x\nerror: timeout: dock never became ready\n\x1b[K[ OK ] late console\n';
    expect(lastLine(noisy)).toBe('error: timeout: dock never became ready');
    expect(lastLine('only line')).toBe('only line');
  });
});
