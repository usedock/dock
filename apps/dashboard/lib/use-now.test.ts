import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTicker, type VisibilityTarget } from './use-now';

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    listeners,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    fire() {
      listeners.forEach((fn) => fn());
    },
  };
}

describe('startTicker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks every interval', () => {
    const doc = fakeDoc();
    const onTick = vi.fn();
    startTicker(doc as unknown as VisibilityTarget, 1000, onTick);
    vi.advanceTimersByTime(3000);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it('skips ticks while hidden and refreshes when visible again', () => {
    const doc = fakeDoc();
    const onTick = vi.fn();
    startTicker(doc as unknown as VisibilityTarget, 1000, onTick);
    doc.hidden = true;
    vi.advanceTimersByTime(3000);
    doc.fire();
    expect(onTick).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.fire();
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('clears the interval and listener on stop', () => {
    const doc = fakeDoc();
    const onTick = vi.fn();
    const stop = startTicker(doc as unknown as VisibilityTarget, 1000, onTick);
    stop();
    vi.advanceTimersByTime(5000);
    expect(onTick).not.toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
  });
});
