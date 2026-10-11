import type { Runtime, Snapshot, SnapshotStatus } from '../database/schema';

/** Public API shape of a snapshot; built field by field so new columns are never exposed by default. */
export interface SnapshotView {
  id: string;
  dockId: string;
  status: SnapshotStatus;
  sizeBytes: number;
  runtime: Runtime | null;
  createdAt: Date;
}

export function snapshotView(snap: Snapshot): SnapshotView {
  return {
    id: snap.id,
    dockId: snap.dockId,
    status: snap.status,
    sizeBytes: snap.sizeBytes,
    runtime: snap.runtime,
    createdAt: snap.createdAt,
  };
}
