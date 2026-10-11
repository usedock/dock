import { Injectable } from '@nestjs/common';
import type { Dock, Runtime } from '../database/schema';
import type { SnapshotManifest } from '../database/schema/snapshots';

/** Provider-issued point-in-time capture of one dock. */
export interface SnapshotCapture {
  snapshotId: string;
  sizeBytes: number;
  cpuFamily: string;
  runtime: Runtime;
  kernelRelease: string | null;
  /** Base image a microVM delta generation restores onto; restores are placed only on hosts holding it. */
  baseFingerprint: string | null;
  manifest: SnapshotManifest;
}

/** Whole-disk capture of a dock for export: one compressed ext4 image in the store. */
export interface DiskExport {
  snapshotId: string;
  sizeBytes: number;
  sha256: string;
  /** Dockyard image the disk was built from; empty when the base was built on the host. */
  baseImage: string;
}

/** Provisioned-machine handle returned by lifecycle calls. */
export interface MachineHandle {
  ip: string;
  /** Owning host; null for the fake driver, set for real placements. */
  hostId?: string | null;
}

/** One bounded guest command, run as the dock user under bash -lc. */
export interface ExecRequest {
  script: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
  idempotencyToken: string;
}

/** Guest exec result; streams keep their head when truncated. */
export interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Hypervisor/storage port. Services own the state machine; the provider
 * only performs capture/copy/destroy work. The fake below is the only
 * implementation until a real driver lands.
 */
export interface ComputeProvider {
  /** Every machine boots with the guest exec agent; egressAllow confines it (internal runs, and environments with an allowlist). */
  provision(dock: Dock, opts?: { snapshotId?: string | null; hostId?: string | null; egressAllow?: string[] }): Promise<MachineHandle>;
  captureSnapshot(dock: Dock, parentId: string | null): Promise<SnapshotCapture>;
  captureFinal(dock: Dock, parentId: string | null): Promise<SnapshotCapture>;
  /** Full (never delta) disk-only capture; the dock keeps running. */
  captureDisk(dock: Dock): Promise<DiskExport>;
  resume(dock: Dock, opts: { snapshotId: string | null; hostId?: string | null; egressAllow?: string[] }): Promise<MachineHandle>;
  branch(source: Dock, target: Dock, opts?: { snapshotId?: string | null; hostId?: string | null; egressAllow?: string[] }): Promise<MachineHandle>;
  destroyBacking(dock: Dock): Promise<void>;
  deleteBacking(id: string): Promise<void>;
  exec(dock: Dock, request: ExecRequest): Promise<ExecOutcome>;
}

/** DI token for the ComputeProvider port. */
export const COMPUTE_PROVIDER = 'COMPUTE_PROVIDER';

/** Deterministic octet derived from the dock id (stable across calls). */
function octetFor(id: string): number {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return (sum % 250) + 2;
}

/**
 * Deterministic in-process driver: completes every transition inline with
 * fixed sizes and marker manifests. Test failure injection via
 * failNextCapture(); no timers anywhere.
 */
@Injectable()
export class FakeComputeProvider implements ComputeProvider {
  private failuresLeft = 0;
  private captures = 0;

  /** Next N capture calls throw instead of capturing. Tests only. */
  failNextCapture(n = 1): void {
    this.failuresLeft += n;
  }

  async provision(dock: Dock): Promise<MachineHandle> {
    return { ip: `10.0.0.${octetFor(dock.id)}` };
  }

  async captureSnapshot(dock: Dock, _parentId: string | null): Promise<SnapshotCapture> {
    this.maybeFail('captureSnapshot');
    this.captures += 1;
    return { snapshotId: `fake-snap-${this.captures}`, sizeBytes: 6000, cpuFamily: 'fake', runtime: dock.runtime, kernelRelease: null, baseFingerprint: null, manifest: markerManifest(dock) };
  }

  async captureFinal(dock: Dock, _parentId: string | null): Promise<SnapshotCapture> {
    this.maybeFail('captureFinal');
    return this.captureSnapshot(dock, _parentId);
  }

  async captureDisk(dock: Dock): Promise<DiskExport> {
    this.maybeFail('captureDisk');
    this.captures += 1;
    return { snapshotId: `fake-export-${this.captures}`, sizeBytes: 6000, sha256: 'f'.repeat(64), baseImage: dock.image };
  }

  async resume(dock: Dock): Promise<MachineHandle> {
    return { ip: `10.0.0.${octetFor(dock.id)}` };
  }

  async branch(_source: Dock, target: Dock): Promise<MachineHandle> {
    return { ip: `10.0.0.${octetFor(target.id)}` };
  }

  async destroyBacking(_dock: Dock): Promise<void> {}

  async deleteBacking(_id: string): Promise<void> {}

  async exec(_dock: Dock, _request: ExecRequest): Promise<ExecOutcome> {
    return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false };
  }

  private maybeFail(op: string): void {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error(`fake ${op} failed`);
    }
  }
}

/** Single marker file identifying the dock a fake capture came from. */
function markerManifest(dock: Dock): SnapshotManifest {
  const content = JSON.stringify({ dockId: dock.id, name: dock.name });
  return { files: [{ path: 'home/user/.dock-info.json', size: content.length, content }] };
}
