import { describe, expect, it } from 'vitest';
import type { Dock } from './dock-api';
import { formatMemoryInUse, gettingStarted, recentItems, sectionValue, summarizeDocks } from './home-summary';

const dock = (over: Partial<Dock>): Dock => ({
  id: 'd',
  workspaceId: 'w',
  name: 'n',
  cpus: 2,
  memoryMiB: 4096,
  diskGiB: 20,
  runtime: 'microvm',
  persistentPaths: ['/'],
  state: 'running',
  ...over,
});

describe('summarizeDocks', () => {
  it('counts states and sums resources of running docks only', () => {
    const s = summarizeDocks([
      dock({ state: 'running', cpus: 2, memoryMiB: 4096 }),
      dock({ state: 'ready', cpus: 4, memoryMiB: 8192 }),
      dock({ state: 'archived', cpus: 8, memoryMiB: 16384 }),
      dock({ state: 'provisioning' }),
    ]);
    expect(s).toEqual({ running: 2, stopped: 1, vcpusInUse: 6, memoryMiBInUse: 12288 });
  });

  it('counts idle docks toward resources but not running', () => {
    const s = summarizeDocks([dock({ state: 'idle', cpus: 2, memoryMiB: 2048 }), dock({ state: 'running', cpus: 1, memoryMiB: 1024 })]);
    expect(s).toEqual({ running: 1, stopped: 0, vcpusInUse: 3, memoryMiBInUse: 3072 });
  });

  it('handles no docks', () => {
    expect(summarizeDocks([])).toEqual({ running: 0, stopped: 0, vcpusInUse: 0, memoryMiBInUse: 0 });
  });
});

describe('recentItems', () => {
  it('sorts by stateChangedAt, then updatedAt, then createdAt and limits', () => {
    const items = [
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', updatedAt: '2026-01-03T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'c', stateChangedAt: '2026-01-05T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'd' },
    ];
    expect(recentItems(items, 3).map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('formatMemoryInUse', () => {
  it('formats GB', () => {
    expect(formatMemoryInUse(4096)).toBe('4 GB');
    expect(formatMemoryInUse(1536)).toBe('1.5 GB');
    expect(formatMemoryInUse(0)).toBe('0 GB');
  });
});

describe('gettingStarted', () => {
  it('marks incomplete steps', () => {
    const r = gettingStarted({ docks: 0, sshKeys: 1, githubLinked: false, environments: 0 });
    expect(r.items.filter((i) => !i.done).map((i) => i.id)).toEqual(['dock', 'github', 'environment']);
    expect(r.allDone).toBe(false);
  });

  it('is done when everything exists, and treats failed checks as done', () => {
    expect(gettingStarted({ docks: 1, sshKeys: 2, githubLinked: true, environments: 1 }).allDone).toBe(true);
    expect(gettingStarted({ docks: 1, sshKeys: null, githubLinked: null, environments: null }).allDone).toBe(true);
  });
});

describe('sectionValue', () => {
  const stored = { scope: 'ws-a', value: [1, 2] };

  it('returns the value only for the scope it was loaded for', () => {
    expect(sectionValue(stored, 'ws-a', false)).toEqual([1, 2]);
    expect(sectionValue(stored, 'ws-b', false)).toBeNull();
    expect(sectionValue({ scope: 'ws-a', value: 'error' }, 'ws-a', false)).toBe('error');
  });

  it('loads while the selection is pending, then settles as unavailable with no selection', () => {
    expect(sectionValue(stored, null, true)).toBeNull();
    expect(sectionValue(stored, null, false)).toBe('error');
  });
});
