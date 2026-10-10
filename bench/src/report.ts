import os from 'node:os';
import type { ProviderInfo } from './providers/types.ts';
import type { ScenarioResult } from './scenarios.ts';

export interface ClientInfo {
  os: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  memoryGiB: number;
  runtime: string;
}

export interface Report {
  schema: 1;
  date: string;
  provider: string;
  providerInfo: ProviderInfo;
  client: ClientInfo;
  config: { iterations: number; concurrency: number };
  scenarios: ScenarioResult[];
  cleanupFailures: string[];
}

export function clientInfo(): ClientInfo {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
  };
}

export function buildReport(input: Omit<Report, 'schema' | 'date' | 'client'> & { date?: Date; client?: ClientInfo }): Report {
  const { date, client, ...rest } = input;
  return { schema: 1, date: (date ?? new Date()).toISOString(), client: client ?? clientInfo(), ...rest };
}

export function reportFileName(report: Report): string {
  // Time to the second keeps same-day runs from overwriting each other.
  return `${report.date.slice(0, 19).replace(/:/g, '-')}-${report.provider}.json`;
}

const ms = (v: number | null) => (v === null ? '-' : v.toFixed(0));

export function toMarkdown(report: Report): string {
  const { client, providerInfo: p } = report;
  const lines = [
    `Provider: ${report.provider}${p.version ? ` ${p.version}` : ''}${p.runtime ? ` (runtime ${p.runtime})` : ''}`,
    `Date: ${report.date}`,
    `Client: ${client.cpuCount} CPUs (${client.cpuModel}), ${client.memoryGiB} GiB, ${client.os} ${client.arch}, ${client.runtime}`,
    '',
    '| Scenario | Iterations | Success | P50 ms | P95 ms | P99 ms |',
    '|---|---|---|---|---|---|',
  ];
  for (const s of report.scenarios) {
    if (!s.stats) {
      lines.push(`| ${s.scenario} | ${s.iterations} | skipped: ${s.skipped} | - | - | - |`);
      continue;
    }
    const t = s.stats;
    const rate = `${(t.successRate * 100).toFixed(1)}% (${t.successes}/${t.total})`;
    lines.push(`| ${s.scenario} | ${s.iterations} | ${rate} | ${ms(t.p50)} | ${ms(t.p95)} | ${ms(t.p99)} |`);
  }
  const failed = report.scenarios.filter((s) => s.stats && s.stats.failures > 0);
  if (failed.length) {
    lines.push('', 'Failures:');
    for (const s of failed) {
      for (const [msg, n] of Object.entries(s.stats!.errors)) lines.push(`- ${s.scenario}: ${n} x ${msg}`);
    }
  }
  if (report.cleanupFailures.length) {
    lines.push('', `Cleanup failures (${report.cleanupFailures.length}):`, ...report.cleanupFailures.map((f) => `- ${f}`));
  }
  return lines.join('\n');
}
