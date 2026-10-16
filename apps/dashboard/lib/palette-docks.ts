import type { Dock } from '@/lib/dock-api';

export const MAX_PALETTE_DOCKS = 50;

/** Docks of one workspace, newest activity first. */
export function workspaceDocks(docks: Dock[], workspaceId: string | null): Dock[] {
  const time = (d: Dock) => Date.parse(d.updatedAt ?? d.createdAt ?? '') || 0;
  return docks.filter((d) => !workspaceId || d.workspaceId === workspaceId).sort((a, b) => time(b) - time(a));
}

/** Rows to render: capped while the query is empty, every dock once the user types so none is unreachable. */
export function paletteDocks(docks: Dock[], search: string): Dock[] {
  return search.trim() ? docks : docks.slice(0, MAX_PALETTE_DOCKS);
}

/** cmdk match string: name and full id. */
export function dockSearchValue(dock: Pick<Dock, 'id' | 'name'>): string {
  return `${dock.name} ${dock.id}`;
}

/** Id as shown in the docks list. */
export function shortDockId(id: string): string {
  return id.slice(0, 8);
}
