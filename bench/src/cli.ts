import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { TrackedProvider } from './cleanup.ts';
import { PROVIDER_NAMES, selectProvider } from './providers/index.ts';
import { reportFileName, toCsv, toMarkdown } from './report.ts';
import { runBenchmark } from './run.ts';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'dock' },
    scenario: { type: 'string', default: 'all' },
    iterations: { type: 'string', default: '100' },
    concurrency: { type: 'string', default: '100' },
    out: { type: 'string', default: 'results' },
  },
});

const positive = (v: string, flag: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${flag} must be a positive integer`);
  return n;
};

async function main(): Promise<number> {
  const choice = selectProvider(values.provider!);
  if ('skipped' in choice) {
    console.log(choice.skipped);
    return 0;
  }
  let tracker: TrackedProvider | undefined;
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error('Interrupted: destroying created sandboxes (press again to force quit)');
    void (tracker?.close() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const report = await runBenchmark({
    provider: choice.provider,
    scenario: values.scenario!,
    iterations: positive(values.iterations!, 'iterations'),
    concurrency: positive(values.concurrency!, 'concurrency'),
    onTracker: (t) => (tracker = t),
  });
  await mkdir(values.out!, { recursive: true });
  const file = join(values.out!, reportFileName(report));
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  const csv = file.replace(/\.json$/, '.csv');
  await writeFile(csv, toCsv(report));
  console.log(toMarkdown(report));
  console.log(`\nWrote ${file} and ${csv}`);
  return report.cleanupFailures.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    console.error(`Providers: ${PROVIDER_NAMES.join(', ')}`);
    process.exit(1);
  },
);
