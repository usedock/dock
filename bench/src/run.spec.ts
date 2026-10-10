import { describe, expect, it } from 'vitest';
import { TrackedProvider } from './cleanup.ts';
import { selectProvider } from './providers/index.ts';
import type { ExecResult, Handle, Provider } from './providers/types.ts';
import { runBenchmark } from './run.ts';
import { resolveScenarios } from './scenarios.ts';

class FakeProvider implements Provider {
  name = 'fake';
  supports = { stopResume: true, branch: true };
  live = new Set<string>();
  private seq = 0;
  failExec = false;
  failCreateAt = -1;
  creates = 0;

  async create(): Promise<Handle> {
    const n = this.creates++;
    if (n === this.failCreateAt) throw new Error('create refused');
    const id = `h${++this.seq}`;
    this.live.add(id);
    return { id };
  }
  async exec(): Promise<ExecResult> {
    if (this.failExec) throw new Error('exec failed');
    return { exitCode: 0, stdout: '' };
  }
  async stop() {}
  async resume() {}
  async branch(_h: Handle, n: number): Promise<Handle[]> {
    return Array.from({ length: n }, () => {
      const id = `h${++this.seq}`;
      this.live.add(id);
      return { id };
    });
  }
  async destroy(h: Handle) {
    this.live.delete(h.id);
  }
  async info() {
    return { version: 'fake-1', runtime: 'gvisor' };
  }
}

describe('runBenchmark', () => {
  it('runs every scenario and leaves no sandbox behind', async () => {
    const p = new FakeProvider();
    const report = await runBenchmark({ provider: p, scenario: 'all', iterations: 3, concurrency: 3 });
    expect(report.scenarios.map((s) => s.scenario)).toEqual(['burst', 'sequential', 'exec', 'resume', 'branch-3', 'branch-10']);
    for (const s of report.scenarios) expect(s.stats).toMatchObject({ total: 3, successRate: 1 });
    expect(p.live.size).toBe(0);
    expect(report.providerInfo).toEqual({ version: 'fake-1', runtime: 'gvisor' });
  });

  it('destroys sandboxes and records failures when exec fails', async () => {
    const p = new FakeProvider();
    p.failExec = true;
    const report = await runBenchmark({ provider: p, scenario: 'burst', iterations: 4, concurrency: 4 });
    const stats = report.scenarios[0].stats!;
    expect(stats).toMatchObject({ total: 4, failures: 4, successRate: 0, p50: null });
    expect(stats.errors).toEqual({ 'exec failed': 4 });
    expect(p.live.size).toBe(0);
  });

  it('counts a failed create against success rate while others still succeed', async () => {
    const p = new FakeProvider();
    p.failCreateAt = 1;
    const report = await runBenchmark({ provider: p, scenario: 'sequential', iterations: 4, concurrency: 1 });
    expect(report.scenarios[0].stats).toMatchObject({ total: 4, successes: 3, failures: 1, successRate: 0.75 });
    expect(p.live.size).toBe(0);
  });

  it('skips scenarios the provider cannot do', async () => {
    const p = new FakeProvider();
    p.supports = { stopResume: false, branch: false };
    const report = await runBenchmark({ provider: p, scenario: 'resume', iterations: 2, concurrency: 1 });
    expect(report.scenarios[0].skipped).toContain('stop and resume');
    expect(report.scenarios[0].stats).toBeUndefined();
  });

  it('cleans up even when a scenario throws unexpectedly', async () => {
    const p = new FakeProvider();
    p.stop = async () => {
      throw new Error('stop exploded');
    };
    const report = await runBenchmark({ provider: p, scenario: 'resume', iterations: 2, concurrency: 2 });
    expect(report.scenarios[0].stats!.errors).toEqual({ 'stop exploded': 2 });
    expect(p.live.size).toBe(0);
  });

  it('rejects unknown scenarios', () => {
    expect(() => resolveScenarios('nope')).toThrow('Unknown scenario');
  });
});

describe('TrackedProvider', () => {
  it('destroys everything still live on cleanup, recording failures', async () => {
    const p = new FakeProvider();
    const t = new TrackedProvider(p);
    const a = await t.create();
    await t.create();
    p.destroy = async (h) => {
      if (h.id === a.id) throw new Error('stuck');
      p.live.delete(h.id);
    };
    await t.cleanup();
    expect(p.live.size).toBe(1);
    expect(t.cleanupFailures).toEqual([`${a.id}: stuck`]);
  });

  it('close waits for an in-flight create and destroys it before resolving (Ctrl-C mid create)', async () => {
    const p = new FakeProvider();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowCreate = p.create.bind(p);
    p.create = async () => {
      await gate;
      return slowCreate();
    };
    const t = new TrackedProvider(p);
    const pending = t.create();
    let closed = false;
    const closing = t.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(false);
    release();
    await closing;
    // The CLI exits right after close, so nothing may be left for a later tick.
    expect(p.live.size).toBe(0);
    await pending;
  });

  it('refuses new creates once closed', async () => {
    const p = new FakeProvider();
    const t = new TrackedProvider(p);
    await t.close();
    await expect(t.create()).rejects.toThrow('Run interrupted');
    await expect(t.branch({ id: 'x' }, 3)).rejects.toThrow('Run interrupted');
    expect(p.creates).toBe(0);
    expect(p.live.size).toBe(0);
  });
});

describe('runBenchmark prepare', () => {
  it('runs provider setup once before any clock starts', async () => {
    const p = new FakeProvider();
    const order: string[] = [];
    (p as Provider).prepare = async () => {
      order.push('prepare');
    };
    const create = p.create.bind(p);
    p.create = async () => {
      order.push('create');
      return create();
    };
    await runBenchmark({ provider: p, scenario: 'burst', iterations: 2, concurrency: 2 });
    expect(order).toEqual(['prepare', 'create', 'create']);
  });
});

describe('selectProvider', () => {
  it('skips a provider whose key is unset and names the variable', () => {
    expect(selectProvider('e2b', {})).toEqual({ skipped: 'e2b skipped: set E2B_API_KEY' });
    expect(selectProvider('modal', { MODAL_TOKEN_ID: 'x' })).toEqual({ skipped: 'modal skipped: set MODAL_TOKEN_SECRET' });
    expect(selectProvider('vercel', { VERCEL_TOKEN: 't' })).toEqual({ skipped: 'vercel skipped: set VERCEL_TEAM_ID, VERCEL_PROJECT_ID' });
  });

  it('builds Dock from DOCK_API_URL and DOCK_API_KEY alone', () => {
    const c = selectProvider('dock', { DOCK_API_URL: 'http://x', DOCK_API_KEY: 'dock_k' });
    expect('provider' in c && c.provider.name).toBe('dock');
  });

  it('rejects an unknown provider', () => {
    expect(() => selectProvider('nope', {})).toThrow('Unknown provider');
  });
});
