import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Dock } from '../database/schema';
import type { SnapshotManifest } from '../database/schema/snapshots';
import type { ComputeProvider, ExecOutcome, ExecRequest, MachineHandle, SnapshotCapture } from '../docks/compute.provider';
import { DockletException, resourcesOf } from './docklet.client';
import type { DockletFactory } from '../hosts/docklets.factory';
import { FleetObjectsService } from '../fleet/fleet-objects.service';

/**
 * Restate-selected ComputeProvider. Routes every host call through the
 * docklet owning the targeted dock, falling back to the default docklet
 * when no host is assigned yet; a docklet reporting a different hostId
 * than targeted fails the op without persisting.
 */
@Injectable()
export class RestateComputeProvider implements ComputeProvider {
  constructor(
    private readonly docklets: DockletFactory,
    private readonly objects: FleetObjectsService,
  ) {}

  async provision(
    dock: Dock,
    opts?: { snapshotId?: string | null; hostId?: string | null; egressAllow?: string[] },
  ): Promise<MachineHandle> {
    const client = await this.docklets(opts?.hostId ?? dock.hostId ?? null);
    const res = await client.provision({
      dockId: dock.id,
      resources: resourcesOf(dock),
      image: dock.image,
      snapshotId: opts?.snapshotId ?? undefined,
      execAgent: true,
      ...(opts?.egressAllow?.length ? { egressAllow: opts.egressAllow } : {}),
      idempotencyToken: randomUUID(),
    });
    this.checkHost(res.hostId, opts?.hostId);
    return { ip: res.ip, hostId: res.hostId };
  }

  async captureSnapshot(dock: Dock, parentId: string | null): Promise<SnapshotCapture> {
    const client = await this.docklets(dock.hostId ?? null);
    const res = await client.snapshotCreate(dock.id, parentId, 'diff', true);
    return { snapshotId: res.snapshotId, sizeBytes: res.sizeBytes, cpuFamily: res.cpuFamily, runtime: dock.runtime, kernelRelease: null, baseFingerprint: fingerprintOf(res.baseFingerprint), manifest: cpuFamilyManifest(res.cpuFamily, dock.id) };
  }

  async captureFinal(dock: Dock, parentId: string | null): Promise<SnapshotCapture> {
    const client = await this.docklets(dock.hostId ?? null);
    const res = await client.snapshotCreate(dock.id, parentId, 'full', false, false, finalCaptureToken(dock.id, parentId));
    return { snapshotId: res.snapshotId, sizeBytes: res.sizeBytes, cpuFamily: res.cpuFamily, runtime: dock.runtime, kernelRelease: null, baseFingerprint: fingerprintOf(res.baseFingerprint), manifest: cpuFamilyManifest(res.cpuFamily, dock.id) };
  }

  async resume(dock: Dock, opts: { snapshotId: string | null; hostId?: string | null }): Promise<MachineHandle> {
    if (!opts.snapshotId) throw new Error(`Dock ${dock.id} has no stored snapshot generation to resume from`);
    const client = await this.docklets(opts.hostId ?? dock.hostId ?? null);
    const res = await client.snapshotLoad(dock.id, resourcesOf(dock), dock.image, opts.snapshotId, true);
    this.checkHost(res.hostId, opts.hostId);
    return { ip: res.ip, hostId: res.hostId };
  }

  async branch(
    source: Dock,
    target: Dock,
    opts?: { snapshotId?: string | null; hostId?: string | null; coldBoot?: boolean },
  ): Promise<MachineHandle> {
    const client = await this.docklets(opts?.hostId ?? target.hostId ?? null);
    const res = await client.provision({
      dockId: target.id,
      resources: resourcesOf(target),
      image: target.image,
      snapshotId: opts?.snapshotId ?? undefined,
      execAgent: true,
      idempotencyToken: randomUUID(),
    });
    this.checkHost(res.hostId, opts?.hostId);
    return { ip: res.ip, hostId: res.hostId };
  }

  async destroyBacking(dock: Dock): Promise<void> {
    // A dock that never placed (a failed first provision, for example) has no
    // backing anywhere, so it must still be deletable rather than failing on
    // a host lookup that can never succeed.
    if (!dock.hostId) return;
    const client = await this.docklets(dock.hostId);
    await client.destroy(dock.id);
  }

  /**
   * Drops a generation's objects from the central store.
   *
   * The docklet reaches generations through this control plane, so the backend
   * is the only component that can delete them; leaving the objects behind
   * after the row is gone would grow the store without bound. `id` is the
   * store-side generation id, not the snapshot row id.
   */
  async deleteBacking(id: string): Promise<void> {
    if (!id) return;
    await this.objects.deleteGeneration(id);
  }

  /** Runs one script through the dock's guest agent; the docklet answers exec_unavailable without one. */
  async exec(dock: Dock, request: ExecRequest): Promise<ExecOutcome> {
    const client = await this.docklets(dock.hostId ?? null);
    const res = await client.fastRunExec({
      runtimeId: dock.id,
      script: request.script,
      timeoutSeconds: request.timeoutSeconds,
      ...(request.env && Object.keys(request.env).length ? { env: request.env } : {}),
      idempotencyToken: request.idempotencyToken,
    });
    return { exitCode: res.exitCode, stdout: res.stdout ?? '', stderr: res.stderr ?? '', truncated: res.truncated === true, timedOut: res.timedOut === true };
  }

  /** Targeted placements must come back from the same host; anything else is a routing fault. */
  private checkHost(reported: string, targeted?: string | null): void {
    if (targeted && reported !== targeted) {
      throw new DockletException('host_mismatch', `Docklet ${reported} answered for targeted host ${targeted}`);
    }
  }

}

/** Stable token per archiving episode: the parent advances with every recorded
capture, so a retried episode replays the same generation while the next stop
starts a new one. Crash recovery reuses it to adopt orphaned captures. */
export function finalCaptureToken(dockId: string, parentId: string | null): string {
  return `final:${dockId}:${parentId ?? 'root'}`;
}

/** Hosts are only trusted to report a well-formed sha256; anything else records no base. */
function fingerprintOf(value: string | undefined): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** Snapshot manifests record the host CPU family for placement refusal. */
function cpuFamilyManifest(cpuFamily: string, dockId: string): SnapshotManifest {
  return { files: [{ path: 'home/user/.dock-info.json', size: cpuFamily.length + dockId.length, content: JSON.stringify({ dockId, cpuFamily }) }] };
}
