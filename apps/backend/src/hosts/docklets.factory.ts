import { ConfigService } from '@nestjs/config';
import { HostsService } from './hosts.service';
import { DockletClient } from '../runtime/docklet.client';
import { FleetHostAgent } from '../runtime/fleet-host-agent';
import { HostCommandQueue } from '../fleet/host-command-queue';
import type { HostAgent } from '../runtime/host-agent';

/** Resolves the host agent owning a host; null uses the fallback agent. */
export type DockletFactory = (hostId: string | null) => Promise<HostAgent>;
export const DOCKLETS = 'DOCKLETS';

/**
 * Per-host agents from the host registry.
 *
 * In fleet mode (`RUNTIME_DRIVER=restate`) every agent is queue-backed: the
 * operation is enqueued for the host and the docklet collects it on its
 * outbound long poll, so nothing dials a sandbox machine.
 *
 * Outside fleet mode the direct HTTP client is kept for single-host development,
 * where the docklet runs beside the backend and no control plane is involved.
 */
export function buildDockletFactory(
  hosts: HostsService,
  config: ConfigService,
  fallback: DockletClient,
  queue: HostCommandQueue,
): DockletFactory {
  const fleetMode = config.get<string>('RUNTIME_DRIVER') === 'restate';
  const cache = new Map<string, FleetHostAgent>();
  return async (hostId: string | null) => {
    if (!fleetMode) return fallback;
    if (!hostId) {
      // Lifecycle calls always carry the host that owns the dock; a missing
      // host is a bug, not a reason to fall back to a local machine.
      throw new Error('fleet mode requires a hostId to address a host operation');
    }
    // Unknown hosts must fail here rather than queue work nobody will collect.
    const host = await hosts.getById(hostId);
    if (!host) throw new Error(`unknown host ${hostId}`);
    const hit = cache.get(hostId);
    if (hit) return hit;
    const agent = new FleetHostAgent(queue, hostId);
    cache.set(hostId, agent);
    return agent;
  };
}
