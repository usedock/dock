import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FAST_MICROVM_CAPABILITIES,
  RUN_CAPABILITY_VERSION,
  assertRuntimeCapabilityContract,
  missingRunCapabilities,
} from '../github/run-capabilities';
import type { DockletFactory } from '../hosts/docklets.factory';
import type {
  DockletFastRunCapabilities,
  DockletResources,
  DockletFastRunExecResult,
  DockletFastRunReadResult,
} from './docklet.client';
import type { HostAgent } from './host-agent';

export const FAST_RUN_PROVIDER = 'FAST_RUN_PROVIDER';

export interface FastRunCreateInput {
  runtimeId: string;
  hostId?: string | null;
  resources: DockletResources;
  image: string;
  capabilities: DockletFastRunCapabilities;
  /** HTTPS hosts the runtime may reach; unset leaves egress open. */
  egressAllow?: string[];
}

export interface FastRunHandle {
  runtimeId: string;
  hostId: string | null;
  ip: string;
  capabilities: DockletFastRunCapabilities;
}

/** Addresses one guest exec agent: a Fast Run runtime or an agent-enabled dock. */
export interface RuntimeRef {
  hostId: string | null;
  runtimeId: string;
}

export interface FastRunProvider {
  create(input: FastRunCreateInput): Promise<FastRunHandle>;
  exec(ref: RuntimeRef, script: string, timeoutSeconds: number, idempotencyToken: string, env?: Record<string, string>): Promise<DockletFastRunExecResult>;
  read(ref: RuntimeRef, path: string, idempotencyToken: string): Promise<DockletFastRunReadResult>;
  collectArtifacts(ref: RuntimeRef, paths: string[], idempotencyPrefix: string): Promise<Record<string, string>>;
  terminate(ref: RuntimeRef, idempotencyToken: string): Promise<void>;
}

/** Backend adapter for the versioned docklet Fast Run protocol; stateless so restarts never orphan runtimes. */
@Injectable()
export class DockletFastRunProvider implements FastRunProvider {
  constructor(private readonly docklets: DockletFactory) {}

  async create(input: FastRunCreateInput): Promise<FastRunHandle> {
    assertRuntimeCapabilityContract(input.capabilities);
    const missing = missingRunCapabilities(input.capabilities.capabilities, FAST_MICROVM_CAPABILITIES);
    if (missing.length) throw new Error(`capability_unavailable: ${missing.join(',')}`);
    const client = await this.docklets(input.hostId ?? null);
    const handle = await client.fastRunCreate({
      runtimeId: input.runtimeId,
      resources: input.resources,
      image: input.image,
      capabilities: input.capabilities,
      ...(input.egressAllow ? { egressAllow: input.egressAllow } : {}),
      guestToken: randomUUID(),
      idempotencyToken: `fast:${input.runtimeId}:create`,
    });
    assertConformingFastCapabilities(handle.capabilities, input.capabilities.capabilities);
    return { runtimeId: handle.runtimeId, hostId: handle.hostId, ip: handle.ip, capabilities: handle.capabilities };
  }

  async exec(ref: RuntimeRef, script: string, timeoutSeconds: number, idempotencyToken: string, env?: Record<string, string>): Promise<DockletFastRunExecResult> {
    const client = await this.docklets(ref.hostId);
    return client.fastRunExec({ runtimeId: ref.runtimeId, script, timeoutSeconds, env, idempotencyToken });
  }

  async read(ref: RuntimeRef, path: string, idempotencyToken: string): Promise<DockletFastRunReadResult> {
    const client = await this.docklets(ref.hostId);
    return client.fastRunRead({ runtimeId: ref.runtimeId, path, idempotencyToken });
  }

  /** Missing files are skipped so one absent log never hides the rest. */
  async collectArtifacts(ref: RuntimeRef, paths: string[], idempotencyPrefix: string): Promise<Record<string, string>> {
    const artifacts: Record<string, string> = {};
    for (const [index, path] of paths.entries()) {
      try {
        const token = `${idempotencyPrefix}:read:${index}`;
        const result = await this.read(ref, path, token).catch((err: unknown) => {
          // Reads are side-effect free, so a not-retained replay re-reads once under a fresh token.
          if ((err as { code?: unknown })?.code !== 'result_not_retained') throw err;
          return this.read(ref, path, `${token}:r1`);
        });
        artifacts[path] = Buffer.from(result.content, 'base64').toString('utf8');
      } catch {
        continue;
      }
    }
    return artifacts;
  }

  async terminate(ref: RuntimeRef, idempotencyToken: string): Promise<void> {
    const client = await this.docklets(ref.hostId);
    await client.fastRunTerminate(ref.runtimeId, idempotencyToken);
  }
}
/** Warm microVMs never offer takeover or durable state; reject drifted claims. */
export function assertConformingFastCapabilities(
  offered: DockletFastRunCapabilities,
  requested: Record<string, boolean | undefined>,
): void {
  assertRuntimeCapabilityContract(offered);
  if (offered.version !== RUN_CAPABILITY_VERSION) throw new Error(`capability_unavailable: unsupported version ${offered.version}`);
  if (offered.target !== 'fast') throw new Error('capability_unavailable: non-fast runtime offered');
  const caps = offered.capabilities as Record<string, boolean | undefined>;
  if (caps.sshTakeover === true || caps.persistentState === true) {
    throw new Error('capability_unavailable: warm microVM must not claim takeover or durable state');
  }
  const missing = missingRunCapabilities(requested as never, offered.capabilities as never);
  if (missing.length) throw new Error(`capability_unavailable: ${missing.join(',')}`);
}
