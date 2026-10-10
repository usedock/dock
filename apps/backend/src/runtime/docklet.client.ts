import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';

export class DockletException extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface DockletEnvelope<T> {
  ok: boolean;
  code?: string;
  message?: string;
  data?: T;
}

/** Per-dock size the docklet budgets host capacity by. */
export interface DockletResources {
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
}

/** Size of a dock row in the docklet payload shape. */
export function resourcesOf(dock: DockletResources): DockletResources {
  return { cpus: dock.cpus, memoryMiB: dock.memoryMiB, diskGiB: dock.diskGiB };
}

/** Provision payload mirroring the docklet /v1/provision contract. */
export interface DockletProvision {
  dockId: string;
  resources: DockletResources;
  image: string;
  snapshotId?: string;
  /** Boots the guest exec agent so harness runs can drive the dock. */
  execAgent?: boolean;
  /** Confines the guest to these HTTPS hosts through the host proxy; requires execAgent. */
  egressAllow?: string[];
  idempotencyToken: string;
}

export interface DockletFastRunCapabilities {
  version: number;
  target: string;
  profile: string;
  capabilities: Record<string, boolean>;
}

export interface DockletFastRunCreate {
  runtimeId: string;
  resources: DockletResources;
  image: string;
  capabilities: DockletFastRunCapabilities;
  egressAllow?: string[];
  guestToken: string;
  idempotencyToken: string;
}

export interface DockletFastRunExec {
  runtimeId: string;
  script: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
  idempotencyToken: string;
}

export interface DockletFastRunExecResult {
  runtimeId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Older docklets omit these; the guest keeps the head of each stream. */
  truncated?: boolean;
  timedOut?: boolean;
}

export interface DockletFastRunRead {
  runtimeId: string;
  path: string;
  idempotencyToken: string;
}

export interface DockletFastRunReadResult {
  runtimeId: string;
  path: string;
  content: string;
  sizeBytes: number;
}

/** Host-reported truth: running microVM inventory for the reconciler. */
export interface DockletStatus {
  hostId: string;
  running: Array<{ dockId: string; state: string; kind?: string }>;
}

/** Host-collected per-dock counters; mirrors the docklet StatsSample. */
export interface DockletSample {
  dockId: string;
  at?: string;
  source?: string;
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  /** Cumulative disk I/O (read + written), not occupancy. */
  diskBytes: number;
  /** Space the dock's disk occupies on the host; absent from older docklets. */
  diskUsedBytes?: number;
  rxBytes: number;
  txBytes: number;
  /** Guest-reported Docker breakdown; best effort, never billing truth. */
  containers?: DockletContainerSample[];
}

export interface DockletContainerSample {
  name: string;
  cpuPercent: number;
  memBytes: number;
}

interface RawResponse {
  status: number;
  text: string;
}

/** Overridable in tests; production uses node http(s) so mTLS applies. */
export type DockletTransport = (method: string, url: string, headers: Record<string, string>, body: string) => Promise<RawResponse>;

/**
 * HTTPS client for one docklet host agent. Uses mTLS only when the CA,
 * cert, and key paths are all configured; otherwise plain HTTP, which is
 * acceptable solely on throwaway test hosts.
 */
@Injectable()
export class DockletClient {
  private readonly baseUrl: string;
  private readonly agent: HttpsAgent | undefined;
  private readonly authorization: string | undefined;
  private readonly transport: DockletTransport;

  constructor(
    config: ConfigService,
    @Optional() transport?: DockletTransport,
    @Optional() baseUrl?: string,
  ) {
    this.transport = transport ?? defaultTransport;
    this.baseUrl = (baseUrl ?? config.get<string>('DOCKLET_BASE_URL') ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
    const localToken = config.get<string>('DOCKLET_LOCAL_TOKEN');
    this.authorization = localToken ? `Bearer ${localToken}` : undefined;
    const ca = config.get<string>('DOCKLET_CA_PATH');
    const cert = config.get<string>('DOCKLET_CERT_PATH');
    const key = config.get<string>('DOCKLET_KEY_PATH');
    if (ca && cert && key) {
      this.agent = new HttpsAgent({ ca: readFileSync(ca), cert: readFileSync(cert), key: readFileSync(key) });
    }
  }

  /** POSTs one docklet op; the token makes workflow replay safe. */
  async call<T>(path: string, body: Record<string, unknown>, token: string = randomUUID()): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-token': token, ...this.authHeader() };
    const payload = JSON.stringify(body);
    const raw =
      this.agent && url.startsWith('https:')
        ? await authedPost('POST', url, headers, payload, this.agent)
        : await this.transport('POST', url, headers, payload);
    let envelope: DockletEnvelope<T>;
    try {
      envelope = JSON.parse(raw.text) as DockletEnvelope<T>;
    } catch {
      throw new DockletException('docklet_unreachable', `Docklet ${path} returned status ${raw.status}`);
    }
    if (raw.status < 200 || raw.status >= 300 || !envelope.ok) {
      throw new DockletException(envelope.code ?? 'docklet_error', envelope.message ?? `Docklet ${path} failed`);
    }
    return envelope.data as T;
  }

  provision(input: DockletProvision): Promise<{ ip: string; hostId: string }> {
    return this.call('/v1/provision', { ...input });
  }

  fastRunCreate(input: DockletFastRunCreate): Promise<{ runtimeId: string; ip: string; hostId: string; capabilities: DockletFastRunCapabilities }> {
    return this.call('/v1/fast-runs/create', { ...input }, input.idempotencyToken);
  }

  fastRunExec(input: DockletFastRunExec): Promise<DockletFastRunExecResult> {
    return this.call('/v1/fast-runs/exec', { ...input }, input.idempotencyToken);
  }

  fastRunRead(input: DockletFastRunRead): Promise<DockletFastRunReadResult> {
    return this.call('/v1/fast-runs/read', { ...input }, input.idempotencyToken);
  }

  fastRunTerminate(runtimeId: string, idempotencyToken: string): Promise<{ runtimeId: string }> {
    return this.call('/v1/fast-runs/terminate', { runtimeId, idempotencyToken }, idempotencyToken);
  }

  pause(dockId: string): Promise<void> {
    return this.call('/v1/pause', { dockId });
  }

  snapshotCreate(
    dockId: string,
    parentId: string | null,
    kind: 'full' | 'diff',
    resumeAfter: boolean,
    memory = false,
    idempotencyToken?: string,
  ): Promise<{ snapshotId: string; sizeBytes: number; cpuFamily: string; baseFingerprint?: string }> {
    return this.call('/v1/snapshots/create', {
      dockId,
      parentId,
      kind,
      resumeAfter,
      memory,
      idempotencyToken: idempotencyToken ?? randomUUID(),
    });
  }

  snapshotLoad(
    dockId: string,
    resources: DockletResources,
    snapshotId: string,
    execAgent?: boolean,
  ): Promise<{ ip: string; hostId: string }> {
    return this.call('/v1/snapshots/load', { dockId, resources, snapshotId, ...(execAgent ? { execAgent: true } : {}) });
  }

  destroy(dockId: string): Promise<void> {
    return this.call('/v1/destroy', { dockId });
  }

  heartbeat(body: Record<string, unknown>): Promise<unknown> {
    return this.call('/v1/heartbeat', body);
  }

  /** Running microVM inventory on this host; drives reconcile repairs. */
  status(): Promise<DockletStatus> {
    return this.get('/v1/status');
  }

  /** Host-truth sample for one dock; missing docks throw docklet errors. */
  sample(dockId: string): Promise<DockletSample> {
    return this.get(`/v1/stats?dock=${encodeURIComponent(dockId)}`);
  }

  /** Store-backed file listing of one generation; needs no booted machine. */
  generationTree(snapshotId: string): Promise<Array<{ path: string; size: number }>> {
    return this.get(`/v1/generations/${snapshotId}/tree`).then((body) => (body as { files: Array<{ path: string; size: number }> }).files);
  }

  /** Single file bytes out of a generation, as UTF-8 text. */
  generationFile(snapshotId: string, path: string): Promise<{ content: string; size: number }> {
    return this.get(`/v1/generations/${snapshotId}/files?path=${encodeURIComponent(path)}`) as Promise<{ content: string; size: number }>;
  }

  private authHeader(): Record<string, string> {
    return this.authorization ? { authorization: this.authorization } : {};
  }

  private async get<T>(path: string): Promise<T> {
    const raw = await this.transport('GET', `${this.baseUrl}${path}`, this.authHeader(), '');
    let envelope: { ok: boolean; code?: string; message?: string; data?: T };
    try {
      envelope = JSON.parse(raw.text) as { ok: boolean; code?: string; message?: string; data?: T };
    } catch {
      throw new DockletException('docklet_unreachable', `Docklet ${path} returned status ${raw.status}`);
    }
    if (raw.status < 200 || raw.status >= 300 || !envelope.ok) {
      throw new DockletException(envelope.code ?? 'docklet_error', envelope.message ?? `Docklet ${path} failed`);
    }
    return envelope.data as T;
  }
}

/** Default transport over node http(s); honors the caller's mTLS agent. */
function defaultTransport(method: string, url: string, headers: Record<string, string>, body: string): Promise<RawResponse> {
  return authedPost(method, url, headers, body, undefined);
}

function authedPost(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  agent: HttpsAgent | undefined,
): Promise<RawResponse> {
  const parsed = new URL(url);
  const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
