import type {
  DockletFastRunCapabilities,
  DockletFastRunCreate,
  DockletFastRunExec,
  DockletFastRunExecResult,
  DockletFastRunRead,
  DockletFastRunReadResult,
  DockletProvision,
  DockletResources,
  DockletSample,
  DockletStatus,
} from './docklet.client';

/**
 * The host-agent surface the control plane depends on. Two implementations
 * satisfy it: `DockletClient` (direct HTTP, single-host/dev use) and
 * `FleetHostAgent` (queue-backed, the production path where hosts only ever
 * connect outbound).
 *
 * Keeping this shape stable is what lets placement, stats, and the reconciler
 * stay unaware of how a command actually reaches a machine.
 */
export interface HostAgent {
  provision(input: DockletProvision): Promise<{ ip: string; hostId: string }>;
  fastRunCreate(input: DockletFastRunCreate): Promise<{
    runtimeId: string;
    ip: string;
    hostId: string;
    capabilities: DockletFastRunCapabilities;
  }>;
  fastRunExec(input: DockletFastRunExec): Promise<DockletFastRunExecResult>;
  fastRunRead(input: DockletFastRunRead): Promise<DockletFastRunReadResult>;
  fastRunTerminate(runtimeId: string, idempotencyToken: string): Promise<{ runtimeId: string }>;
  pause(dockId: string): Promise<void>;
  snapshotCreate(
    dockId: string,
    parentId: string | null,
    kind: 'full' | 'diff',
    resumeAfter: boolean,
    memory?: boolean,
    idempotencyToken?: string,
  ): Promise<{ snapshotId: string; sizeBytes: number; cpuFamily: string; baseFingerprint?: string }>;
  snapshotLoad(
    dockId: string,
    resources: DockletResources,
    image: string,
    snapshotId: string,
    execAgent?: boolean,
  ): Promise<{ ip: string; hostId: string }>;
  destroy(dockId: string): Promise<void>;
  heartbeat(body: Record<string, unknown>): Promise<unknown>;
  status(): Promise<DockletStatus>;
  sample(dockId: string): Promise<DockletSample>;
  generationTree(snapshotId: string): Promise<Array<{ path: string; size: number }>>;
  generationFile(snapshotId: string, path: string): Promise<{ content: string; size: number }>;
}
