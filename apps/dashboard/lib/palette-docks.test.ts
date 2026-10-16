import { describe, expect, it } from 'vitest';
import type { Dock } from './dock-api';
import { dockSearchValue, MAX_PALETTE_DOCKS, paletteDocks } from './palette-docks';

const dock = (id: string, workspaceId: string) => ({ id, name: `n-${id}`, workspaceId }) as Dock;

describe('paletteDocks', () => {
  it('keeps only the selected workspace', () => {
    const rows = [dock('a', 'w1'), dock('b', 'w2')];
    expect(paletteDocks(rows, 'w1').map((d) => d.id)).toEqual(['a']);
  });

  it('keeps all docks when no workspace is selected', () => {
    expect(paletteDocks([dock('a', 'w1'), dock('b', 'w2')], null)).toHaveLength(2);
  });

  it('caps the list', () => {
    const rows = Array.from({ length: MAX_PALETTE_DOCKS + 10 }, (_, i) => dock(String(i), 'w1'));
    expect(paletteDocks(rows, 'w1')).toHaveLength(MAX_PALETTE_DOCKS);
  });
});

describe('dockSearchValue', () => {
  it('includes name and id', () => {
    expect(dockSearchValue({ id: 'dock_1', name: 'api' })).toBe('api dock_1');
  });
});
