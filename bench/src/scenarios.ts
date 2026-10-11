import type { TrackedProvider } from './cleanup.ts';
import type { Handle, Size } from './providers/types.ts';
import { summarize, type Sample, type Stats } from './stats.ts';

export interface ScenarioContext {
  provider: TrackedProvider;
  iterations: number;
  concurrency: number;
  size?: Size;
}

export interface ScenarioResult {
  scenario: string;
  iterations: number;
  concurrency: number;
  skipped?: string;
  stats?: Stats;
  /** Every raw sample in completion order, so the CSV and any re-analysis keep failures visible. */
  samples?: Sample[];
}

export interface Scenario {
  name: string;
  /** Capability the provider must have, if any. */
  needs?: 'stopResume' | 'branch';
  /** Whether the run uses the concurrency setting. */
  concurrent: boolean;
  run(ctx: ScenarioContext, record: (s: Sample) => void): Promise<void>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function execOk(ctx: ScenarioContext, h: Handle): Promise<void> {
  const r = await ctx.provider.exec(h, 'true');
  if (r.exitCode !== 0) throw new Error(`exec exited ${r.exitCode}`);
}

/** Runs fn(0..n-1) with at most `limit` in flight. */
export async function runPool(n: number, limit: number, fn: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < n) await fn(next++);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), n) }, worker));
}

/** Times fn, records success or failure, and always runs the destroy list afterwards. */
async function timed(ctx: ScenarioContext, record: (s: Sample) => void, fn: (own: Handle[]) => Promise<number>): Promise<void> {
  const own: Handle[] = [];
  try {
    record({ ok: true, ms: await fn(own) });
  } catch (e) {
    record({ ok: false, error: errMsg(e) });
  } finally {
    await Promise.allSettled(own.map((h) => ctx.provider.destroy(h)));
  }
}

const createToExec: Scenario['run'] = async (ctx, record) =>
  runPool(ctx.iterations, ctx.concurrency, () =>
    timed(ctx, record, async (own) => {
      const t0 = performance.now();
      const h = await ctx.provider.create(ctx.size);
      own.push(h);
      await execOk(ctx, h);
      return performance.now() - t0;
    }),
  );

const burst: Scenario = { name: 'burst', concurrent: true, run: createToExec };

const sequential: Scenario = { name: 'sequential', concurrent: false, run: createToExec };

const exec: Scenario = {
  name: 'exec',
  concurrent: false,
  async run(ctx, record) {
    let h: Handle;
    try {
      h = await ctx.provider.create(ctx.size);
    } catch (e) {
      for (let i = 0; i < ctx.iterations; i++) record({ ok: false, error: `setup: ${errMsg(e)}` });
      return;
    }
    try {
      for (let i = 0; i < ctx.iterations; i++) {
        const t0 = performance.now();
        try {
          await execOk(ctx, h);
          record({ ok: true, ms: performance.now() - t0 });
        } catch (e) {
          record({ ok: false, error: errMsg(e) });
        }
      }
    } finally {
      await ctx.provider.destroy(h).catch(() => undefined);
    }
  },
};

const resume: Scenario = {
  name: 'resume',
  needs: 'stopResume',
  concurrent: true,
  run: (ctx, record) =>
    runPool(ctx.iterations, ctx.concurrency, () =>
      timed(ctx, record, async (own) => {
        const h = await ctx.provider.create(ctx.size);
        own.push(h);
        await execOk(ctx, h);
        await ctx.provider.stop(h);
        const t0 = performance.now();
        await ctx.provider.resume(h);
        await execOk(ctx, h);
        return performance.now() - t0;
      }),
    ),
};

const branchTo = (n: number): Scenario => ({
  name: `branch-${n}`,
  needs: 'branch',
  concurrent: false,
  run: (ctx, record) =>
    runPool(ctx.iterations, 1, () =>
      timed(ctx, record, async (own) => {
        const source = await ctx.provider.create(ctx.size);
        own.push(source);
        await execOk(ctx, source);
        const t0 = performance.now();
        const copies = await ctx.provider.branch(source, n);
        own.push(...copies);
        await Promise.all(copies.map((c) => execOk(ctx, c)));
        return performance.now() - t0;
      }),
    ),
});

export const SCENARIOS: Scenario[] = [burst, sequential, exec, resume, branchTo(3), branchTo(10)];

export const SCENARIO_ALIASES: Record<string, string[]> = {
  all: SCENARIOS.map((s) => s.name),
  branch: ['branch-3', 'branch-10'],
};

export function resolveScenarios(name: string): Scenario[] {
  const names = SCENARIO_ALIASES[name] ?? [name];
  return names.map((n) => {
    const found = SCENARIOS.find((s) => s.name === n);
    if (!found) throw new Error(`Unknown scenario "${name}"; use ${[...SCENARIOS.map((s) => s.name), ...Object.keys(SCENARIO_ALIASES)].join(', ')}`);
    return found;
  });
}

export async function runScenario(scenario: Scenario, ctx: ScenarioContext): Promise<ScenarioResult> {
  const concurrency = scenario.concurrent ? ctx.concurrency : 1;
  const base = { scenario: scenario.name, iterations: ctx.iterations, concurrency };
  if (scenario.needs && !ctx.provider.supports[scenario.needs]) {
    return { ...base, skipped: `${ctx.provider.name} does not support ${scenario.needs === 'branch' ? 'branch' : 'stop and resume'}` };
  }
  const samples: Sample[] = [];
  await scenario.run({ ...ctx, concurrency }, (s) => samples.push(s));
  return { ...base, stats: summarize(samples), samples };
}
