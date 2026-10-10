import { describe, expect, it } from 'vitest';
import { percentile, summarize, type Sample } from './stats.ts';

const ok = (ms: number): Sample => ({ ok: true, ms });
const fail = (error: string): Sample => ({ ok: false, error });

describe('percentile (nearest-rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('picks the value at rank ceil(p/100 * n)', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it('handles one value and no values', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('summarize', () => {
  it('computes percentiles over unsorted input', () => {
    const s = summarize([ok(30), ok(10), ok(20), ok(40)]);
    expect(s).toMatchObject({ total: 4, successes: 4, failures: 0, successRate: 1, p50: 20, p95: 40, p99: 40, min: 10, max: 40 });
  });

  it('counts failures against success rate and keeps them out of latency', () => {
    const s = summarize([ok(10), ok(20), fail('timeout'), fail('timeout'), fail('capacity_exhausted')]);
    expect(s.total).toBe(5);
    expect(s.successes).toBe(2);
    expect(s.failures).toBe(3);
    expect(s.successRate).toBeCloseTo(0.4);
    expect(s.max).toBe(20);
    expect(s.errors).toEqual({ timeout: 2, capacity_exhausted: 1 });
  });

  it('reports null latencies when everything failed', () => {
    const s = summarize([fail('boom'), fail('boom')]);
    expect(s).toMatchObject({ successRate: 0, p50: null, p95: null, p99: null, min: null, max: null });
    expect(s.errors).toEqual({ boom: 2 });
  });

  it('handles no samples without dividing by zero', () => {
    expect(summarize([])).toMatchObject({ total: 0, successRate: 0, p50: null });
  });
});
