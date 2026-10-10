import { createAll } from './settle.ts';
import { DEFAULT_SIZE, type ExecResult, type Handle, type Provider, type ProviderInfo, type Size } from './types.ts';

export class DockApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface DockOptions {
  apiUrl: string;
  apiKey: string;
  workspaceId?: string;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface DockView {
  id: string;
  name?: string;
  state: string;
  runtime?: string;
}

interface OperationView {
  id: string;
  status: string;
}

const LIVE_STATES = new Set(['ready', 'idle', 'running']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const benchName = () => `bench-${crypto.randomUUID().slice(0, 12)}`;

export class DockProvider implements Provider {
  readonly name = 'dock';
  readonly supports = { stopResume: true, branch: true };
  private readonly base: string;
  private readonly pollMs: number;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private workspace?: Promise<string>;
  private runtime?: string;

  constructor(private readonly opts: DockOptions) {
    this.base = `${opts.apiUrl.replace(/\/+$/, '')}/v1`;
    this.pollMs = opts.pollIntervalMs ?? 250;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 150_000;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await res.text();
    let json: { ok?: boolean; data?: T; code?: string; message?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new DockApiError('bad_response', `HTTP ${res.status} with a non-JSON body`, res.status);
    }
    if (json.ok === true) return json.data as T;
    throw new DockApiError(json.code ?? 'bad_response', json.message ?? `HTTP ${res.status}`, res.status);
  }

  async prepare(): Promise<void> {
    await this.workspaceId();
  }

  private workspaceId(): Promise<string> {
    this.workspace ??= this.opts.workspaceId ? Promise.resolve(this.opts.workspaceId) : this.discoverWorkspace();
    return this.workspace;
  }

  private async discoverWorkspace(): Promise<string> {
    const orgs = await this.call<{ id: string }[]>('GET', '/organizations');
    for (const org of orgs) {
      const spaces = await this.call<{ id: string }[]>('GET', `/organizations/${org.id}/workspaces`);
      if (spaces[0]) return spaces[0].id;
    }
    throw new Error('No workspace found; set DOCK_WORKSPACE_ID');
  }

  private async waitFor(id: string, done: (state: string) => boolean): Promise<DockView> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const dock = await this.call<DockView>('GET', `/docks/${id}`);
      if (done(dock.state)) return dock;
      if (dock.state === 'error') throw new Error(`Dock ${id} entered state error`);
      if (Date.now() > deadline) throw new Error(`Dock ${id} still ${dock.state} after ${this.readyTimeoutMs}ms`);
      await sleep(this.pollMs);
    }
  }

  private async untilLive(dock: DockView): Promise<Handle> {
    const live = LIVE_STATES.has(dock.state) ? dock : await this.waitFor(dock.id, (s) => LIVE_STATES.has(s));
    this.runtime ??= live.runtime;
    return { id: live.id };
  }

  async create(size: Size = DEFAULT_SIZE): Promise<Handle> {
    const workspaceId = await this.workspaceId();
    const name = benchName();
    const dock = await this.reclaimOnFailure(name, this.call<DockView>('POST', '/docks', { workspaceId, name, ...size }));
    try {
      return await this.untilLive(dock);
    } catch (err) {
      // The dock exists server-side even though it never became ready.
      await this.destroy({ id: dock.id }).catch(() => undefined);
      throw err;
    }
  }

  /** A failed or timed-out create may still have made the dock; find it by its unique name and delete it. */
  private async reclaimOnFailure(name: string, call: Promise<DockView>): Promise<DockView> {
    try {
      return await call;
    } catch (err) {
      const docks = await this.call<DockView[]>('GET', '/docks?all=true').catch(() => []);
      await Promise.allSettled(docks.filter((d) => d.name === name).map((d) => this.destroy({ id: d.id })));
      throw err;
    }
  }

  async exec(handle: Handle, cmd: string): Promise<ExecResult> {
    const r = await this.call<{ exitCode: number; stdout: string }>('POST', `/docks/${handle.id}/exec`, { command: cmd });
    return { exitCode: r.exitCode, stdout: r.stdout };
  }

  async stop(handle: Handle): Promise<void> {
    await this.call('POST', `/docks/${handle.id}/stop`, {});
    await this.waitFor(handle.id, (s) => s === 'archived');
  }

  async resume(handle: Handle): Promise<void> {
    await this.call('POST', `/docks/${handle.id}/resume`, {});
    await this.untilLive({ id: handle.id, state: 'provisioning' });
  }

  async branch(handle: Handle, n: number): Promise<Handle[]> {
    return createAll(
      n,
      async () => {
        const name = benchName();
        const dock = await this.reclaimOnFailure(name, this.call<DockView>('POST', `/docks/${handle.id}/branch`, { name }));
        try {
          return await this.untilLive(dock);
        } catch (err) {
          await this.destroy({ id: dock.id }).catch(() => undefined);
          throw err;
        }
      },
      (c) => this.destroy(c),
    );
  }

  async destroy(handle: Handle): Promise<void> {
    let op: OperationView;
    try {
      // DELETE answers { operation }; it is usually already completed.
      ({ operation: op } = await this.call<{ operation: OperationView }>('DELETE', `/docks/${handle.id}`, undefined, { 'x-confirm-delete': handle.id }));
    } catch (err) {
      if (err instanceof DockApiError && err.status === 404) return;
      throw err;
    }
    const deadline = Date.now() + this.readyTimeoutMs;
    for (let status = op.status; ; ) {
      if (status === 'completed') return;
      if (status === 'blocked') throw new Error(`Delete of ${handle.id} is blocked`);
      if (Date.now() > deadline) throw new Error(`Delete of ${handle.id} still ${status}`);
      await sleep(this.pollMs);
      ({ status } = await this.call<OperationView>('GET', `/operations/${op.id}`));
    }
  }

  async info(): Promise<ProviderInfo> {
    const health = await this.call<{ version?: string }>('GET', '/health').catch(() => undefined);
    return { version: health?.version, runtime: this.runtime };
  }
}
