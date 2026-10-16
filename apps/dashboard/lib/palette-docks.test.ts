import { describe, expect, it } from 'vitest';
import type { Dock } from './dock-api';
import { dockSearchValue, MAX_PALETTE_DOCKS, paletteDocks, shortDockId, workspaceDocks } from './palette-docks';

const dock = (id: string, workspaceId: string, updatedAt?: string) => ({ id, name: `n-${id}`, workspaceId, updatedAt }) as Dock;

describe('workspaceDocks', () => {
  it('keeps only the selected workspace', () => {
    const rows = [dock('a', 'w1'), dock('b', 'w2')];
    expect(workspaceDocks(rows, 'w1').map((d) => d.id)).toEqual(['a']);
  });

  it('keeps all docks when no workspace is selected', () => {
    expect(workspaceDocks([dock('a', 'w1'), dock('b', 'w2')], null)).toHaveLength(2);
  });

  it('orders by latest activity', () => {
    const rows = [dock('old', 'w1', '2026-01-01T00:00:00Z'), dock('new', 'w1', '2026-02-01T00:00:00Z')];
    expect(workspaceDocks(rows, 'w1').map((d) => d.id)).toEqual(['new', 'old']);
  });
});

describe('paletteDocks', () => {
  const rows = Array.from({ length: MAX_PALETTE_DOCKS + 10 }, (_, i) => dock(String(i), 'w1'));

  it('caps the list while the query is empty', () => {
    expect(paletteDocks(rows, '')).toHaveLength(MAX_PALETTE_DOCKS);
    expect(paletteDocks(rows, '  ')).toHaveLength(MAX_PALETTE_DOCKS);
  });

  it('keeps every dock searchable once the user types', () => {
    const shown = paletteDocks(rows, 'n-5');
    expect(shown).toHaveLength(MAX_PALETTE_DOCKS + 10);
    expect(shown.map((d) => d.id)).toContain(String(MAX_PALETTE_DOCKS + 5));
  });
});

describe('dockSearchValue', () => {
  it('includes name and full id', () => {
    expect(dockSearchValue({ id: 'dock_1', name: 'api' })).toBe('api dock_1');
  });
});

describe('shortDockId', () => {
  it('shows the first 8 characters', () => {
    expect(shortDockId('0f9c2a7e-1111-2222-3333-444455556666')).toBe('0f9c2a7e');
  });
});
