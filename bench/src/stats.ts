export type Sample = { ok: true; ms: number } | { ok: false; error: string };

export interface Stats {
  total: number;
  successes: number;
  failures: number;
  /** Fraction in [0, 1]; failures count against it. */
  successRate: number;
  /** Latency percentiles over successful samples only; null when there are none. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
  /** Failure count per distinct error message, so failures stay visible. */
  errors: Record<string, number>;
}

/** Nearest-rank percentile: the value at rank ceil(p/100 * n) of the ascending sort. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function summarize(samples: Sample[]): Stats {
  const latencies = samples.flatMap((s) => (s.ok ? [s.ms] : [])).sort((a, b) => a - b);
  const errors: Record<string, number> = {};
  for (const s of samples) if (!s.ok) errors[s.error] = (errors[s.error] ?? 0) + 1;
  const total = samples.length;
  return {
    total,
    successes: latencies.length,
    failures: total - latencies.length,
    successRate: total === 0 ? 0 : latencies.length / total,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: latencies[0] ?? null,
    max: latencies[latencies.length - 1] ?? null,
    errors,
  };
}
