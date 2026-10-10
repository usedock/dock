import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { HostCommandQueue, type FleetOp } from '../fleet/host-command-queue';
import type { HostAgent } from './host-agent';
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
 * Queue-backed host agent: every operation is enqueued for one host and the
 * docklet picks it up over its outbound long poll. The control plane never
 * dials a sandbox machine, so hosts need no public address or open port.
 */
@Injectable()
export class FleetHostAgent implements HostAgent {
  constructor(
    private readonly queue: HostCommandQueue,
    private readonly hostId: string,
  ) {}

  private send<T>(op: FleetOp, payload: Record<string, unknown>, token?: string): Promise<T> {
    return this.queue.execute<T>(this.hostId, op, payload, token ?? randomUUID());
  }

  provision(input: DockletProvision): Promise<{ ip: string; hostId: string }> {
    return this.send('provision', { ...input }, input.idempotencyToken);
  }

  fastRunCreate(input: DockletFastRunCreate): Promise<{
    runtimeId: string;
    ip: string;
    hostId: string;
    capabilities: DockletFastRunCapabilities;
  }> {
    return this.send('fast-run.create', { ...input }, input.idempotencyToken);
  }

  fastRunExec(input: DockletFastRunExec): Promise<DockletFastRunExecResult> {
    return this.send('fast-run.exec', { ...input }, input.idempotencyToken);
  }

  fastRunRead(input: DockletFastRunRead): Promise<DockletFastRunReadResult> {
    return this.send('fast-run.read', { ...input }, input.idempotencyToken);
  }

  fastRunTerminate(runtimeId: string, idempotencyToken: string): Promise<{ runtimeId: string }> {
    return this.send('fast-run.terminate', { runtimeId, idempotencyToken }, idempotencyToken);
  }

  pause(dockId: string): Promise<void> {
    const token = randomUUID();
    return this.send('pause', { dockId, idempotencyToken: token }, token);
  }

  snapshotCreate(
    dockId: string,
    parentId: string | null,
    kind: 'full' | 'diff',
    resumeAfter: boolean,
    memory = false,
    idempotencyToken?: string,
  ): Promise<{ snapshotId: string; sizeBytes: number; cpuFamily: string; baseFingerprint?: string }> {
    const token = idempotencyToken ?? randomUUID();
    return this.send('snapshot.create', { dockId, parentId, kind, resumeAfter, memory, idempotencyToken: token }, token);
  }

  snapshotLoad(
    dockId: string,
    resources: DockletResources,
    snapshotId: string,
    execAgent?: boolean,
  ): Promise<{ ip: string; hostId: string }> {
    const token = randomUUID();
    return this.send('snapshot.load', { dockId, resources, snapshotId, ...(execAgent ? { execAgent: true } : {}), idempotencyToken: token }, token);
  }

  destroy(dockId: string): Promise<void> {
    const token = randomUUID();
    return this.send('destroy', { dockId, idempotencyToken: token }, token);
  }

  /** Hosts push their own heartbeats; this exists only for surface parity. */
  heartbeat(body: Record<string, unknown>): Promise<unknown> {
    return this.send('status', body);
  }

  status(): Promise<DockletStatus> {
    return this.send('status', {});
  }

  sample(dockId: string): Promise<DockletSample> {
    return this.send('stats', { dock: dockId });
  }

  generationTree(snapshotId: string): Promise<Array<{ path: string; size: number }>> {
    return this.send<{ files: Array<{ path: string; size: number }> }>('generation.tree', { snapshotId }).then((body) => body.files);
  }

  generationFile(snapshotId: string, path: string): Promise<{ content: string; size: number }> {
    return this.send('generation.file', { snapshotId, path });
  }
}
