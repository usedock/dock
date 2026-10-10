import { PERSISTENT_PATHS, type Dock } from '../database/schema';

export type DockView = Dock & { persistentPaths: string[] };

/** API shape of a dock: the row plus the paths its runtime keeps across stop and resume. */
export function dockView(dock: Dock): DockView {
  return { ...dock, persistentPaths: [...PERSISTENT_PATHS[dock.runtime]] };
}
