import { TrackedProvider } from './cleanup.ts';
import type { Provider } from './providers/types.ts';
import { buildReport, type Report } from './report.ts';
import { resolveScenarios, runScenario, type ScenarioResult } from './scenarios.ts';

export interface RunOptions {
  provider: Provider;
  scenario: string;
  iterations: number;
  concurrency: number;
  /** Receives the tracker so a signal handler can clean up. */
  onTracker?: (t: TrackedProvider) => void;
}

/** Runs the scenarios in order; every sandbox is destroyed even when a scenario throws. */
export async function runBenchmark(opts: RunOptions): Promise<Report> {
  const tracked = new TrackedProvider(opts.provider);
  opts.onTracker?.(tracked);
  const scenarios = resolveScenarios(opts.scenario);
  const results: ScenarioResult[] = [];
  try {
    for (const s of scenarios) {
      results.push(await runScenario(s, { provider: tracked, iterations: opts.iterations, concurrency: opts.concurrency }));
    }
  } finally {
    await tracked.cleanup();
  }
  return buildReport({
    provider: tracked.name,
    providerInfo: await tracked.info().catch(() => ({})),
    config: { iterations: opts.iterations, concurrency: opts.concurrency },
    scenarios: results,
    cleanupFailures: tracked.cleanupFailures,
  });
}
