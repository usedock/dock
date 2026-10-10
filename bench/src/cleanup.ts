import type { ExecResult, Handle, Provider, ProviderInfo, Size } from './providers/types.ts';

/** Wraps a provider and remembers every live handle so none outlives the run. */
export class TrackedProvider implements Provider {
  private readonly live = new Map<string, Handle>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;
  cleanupFailures: string[] = [];

  constructor(private readonly inner: Provider) {}

  get name() {
    return this.inner.name;
  }
  get supports() {
    return this.inner.supports;
  }

  /** Runs a call that may create sandboxes, refusing new ones once closing and remembering it until it settles. */
  private async creating<T>(start: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Run interrupted');
    const p = start();
    this.inFlight.add(p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(p);
    }
  }

  private track(handles: Handle[]): void {
    for (const h of handles) this.live.set(h.id, h);
  }

  async prepare(): Promise<void> {
    await this.inner.prepare?.();
  }

  async create(size?: Size): Promise<Handle> {
    const h = await this.creating(() => this.inner.create(size));
    this.track([h]);
    return h;
  }

  exec(handle: Handle, cmd: string): Promise<ExecResult> {
    return this.inner.exec(handle, cmd);
  }

  stop(handle: Handle): Promise<void> {
    return this.inner.stop(handle);
  }

  resume(handle: Handle): Promise<void> {
    return this.inner.resume(handle);
  }

  async branch(handle: Handle, n: number): Promise<Handle[]> {
    const copies = await this.creating(() => this.inner.branch(handle, n));
    this.track(copies);
    return copies;
  }

  async destroy(handle: Handle): Promise<void> {
    await this.inner.destroy(handle);
    this.live.delete(handle.id);
  }

  info(): Promise<ProviderInfo> {
    return this.inner.info();
  }

  /** Destroys everything still live; failures are recorded, never thrown. */
  async cleanup(): Promise<void> {
    const pending = [...this.live.values()];
    this.live.clear();
    const results = await Promise.allSettled(pending.map((h) => this.inner.destroy(h)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.cleanupFailures.push(`${pending[i].id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
  }

  /** Refuses new creates, waits for in-flight ones so their sandboxes are known, then destroys everything. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    await this.cleanup();
  }
}
