import { PERSISTENT_PATHS, type Dock, type DockState, type Runtime, type SetupStatus } from '../database/schema';

/** Public API shape of a dock; built field by field so new columns are never exposed by default. */
export interface DockView {
  id: string;
  workspaceId: string;
  name: string | null;
  image: string;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
  runtime: Runtime;
  /** Paths the runtime keeps across stop and resume. */
  persistentPaths: string[];
  state: DockState;
  ttlSeconds: number | null;
  environment: string;
  /** Connector kinds the dock may use through the gateway. */
  connectors: string[];
  fromTemplate: string | null;
  ip: string | null;
  hostId: string | null;
  billingPausedAt: Date | null;
  setupStatus: SetupStatus;
  setupError: string | null;
  lastSnapshotAt: Date | null;
  stateChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function dockView(dock: Dock): DockView {
  return {
    id: dock.id,
    workspaceId: dock.workspaceId,
    name: dock.name,
    image: dock.image,
    cpus: dock.cpus,
    memoryMiB: dock.memoryMiB,
    diskGiB: dock.diskGiB,
    runtime: dock.runtime,
    persistentPaths: [...PERSISTENT_PATHS[dock.runtime]],
    state: dock.state,
    ttlSeconds: dock.ttlSeconds,
    environment: dock.environment,
    connectors: dock.connectors,
    fromTemplate: dock.fromTemplate,
    ip: dock.ip,
    hostId: dock.hostId,
    billingPausedAt: dock.billingPausedAt,
    setupStatus: dock.setupStatus,
    setupError: dock.setupError,
    lastSnapshotAt: dock.lastSnapshotAt,
    stateChangedAt: dock.stateChangedAt,
    createdAt: dock.createdAt,
    updatedAt: dock.updatedAt,
  };
}
