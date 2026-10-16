import type { Dock } from '@/lib/dock-api';

export const MAX_PALETTE_DOCKS = 50;

/** Docks of one workspace, capped for the palette. */
export function paletteDocks(docks: Dock[], workspaceId: string | null): Dock[] {
  return docks.filter((d) => !workspaceId || d.workspaceId === workspaceId).slice(0, MAX_PALETTE_DOCKS);
}

/** cmdk match string: name and id. */
export function dockSearchValue(dock: Pick<Dock, 'id' | 'name'>): string {
  return `${dock.name} ${dock.id}`;
}
