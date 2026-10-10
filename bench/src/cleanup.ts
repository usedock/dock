import type { ExecResult, Handle, Provider, ProviderInfo, Size } from './providers/types.ts';

/** Wraps a provider and remembers every live handle so none outlives the run. */
export class TrackedProvider implements Provider {
  private readonly live = new Map<string, Handle>();
  private closed = false;
  cleanupFailures: string[] = [];

  constructor(private readonly inner: Provider) {}

  get name() {
    return this.inner.name;
  }
  get supports() {
    return this.inner.supports;
  }

  private track(handles: Handle[]): void {
    for (const h of handles) this.live.set(h.id, h);
    // A create that finishes after cleanup started must not leak.
    if (this.closed) void this.cleanup();
  }

  async create(size?: Size): Promise<Handle> {
    const h = await this.inner.create(size);
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
    const copies = await this.inner.branch(handle, n);
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

  /** Cleans up and destroys any handle created from now on as soon as it appears. */
  async close(): Promise<void> {
    this.closed = true;
    await this.cleanup();
  }
}
