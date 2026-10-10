import { describe, expect, it } from 'vitest';
import { buildReport, reportFileName, toMarkdown, type ClientInfo } from './report.ts';
import { summarize } from './stats.ts';

const client: ClientInfo = { os: 'Linux 6.8', arch: 'x64', cpuModel: 'Test CPU', cpuCount: 4, memoryGiB: 16, runtime: 'bun 1.4.0' };

const report = buildReport({
  date: new Date('2026-10-11T12:00:00.000Z'),
  client,
  provider: 'dock',
  providerInfo: { version: '0.1.0', runtime: 'microvm' },
  config: { iterations: 4, concurrency: 4 },
  scenarios: [
    {
      scenario: 'burst',
      iterations: 4,
      concurrency: 4,
      stats: summarize([
        { ok: true, ms: 100 },
        { ok: true, ms: 200 },
        { ok: true, ms: 300 },
        { ok: false, error: 'capacity_exhausted: full' },
      ]),
    },
    { scenario: 'resume', iterations: 4, concurrency: 1, skipped: 'x does not support stop and resume' },
  ],
  cleanupFailures: [],
});

describe('report', () => {
  it('has the documented JSON shape', () => {
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      schema: 1,
      date: '2026-10-11T12:00:00.000Z',
      provider: 'dock',
      providerInfo: { version: '0.1.0', runtime: 'microvm' },
      client: { os: 'Linux 6.8', arch: 'x64', cpuModel: 'Test CPU', cpuCount: 4, memoryGiB: 16 },
      config: { iterations: 4, concurrency: 4 },
      cleanupFailures: [],
    });
    const burst = report.scenarios[0].stats!;
    expect(Object.keys(burst).sort()).toEqual(
      ['errors', 'failures', 'max', 'min', 'p50', 'p95', 'p99', 'successRate', 'successes', 'total'].sort(),
    );
  });

  it('names the file by date and provider', () => {
    expect(reportFileName(report)).toBe('2026-10-11-dock.json');
  });

  it('renders success rate and tails in the table, plus failures and skips', () => {
    const md = toMarkdown(report);
    expect(md).toContain('| Scenario | Iterations | Success | P50 ms | P95 ms | P99 ms |');
    expect(md).toContain('| burst | 4 | 75.0% (3/4) | 200 | 300 | 300 |');
    expect(md).toContain('skipped: x does not support stop and resume');
    expect(md).toContain('burst: 1 x capacity_exhausted: full');
    expect(md).toContain('Provider: dock 0.1.0 (runtime microvm)');
  });
});
