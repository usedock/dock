import { sdkVersion } from './sdk-version.ts';
import type { ExecResult, Handle, Provider, ProviderInfo } from './types.ts';

type E2B = typeof import('e2b');
type Sbx = Awaited<ReturnType<E2B['Sandbox']['create']>>;

export class E2BProvider implements Provider {
  readonly name = 'e2b';
  readonly supports = { stopResume: true, branch: true };
  private readonly boxes = new Map<string, Sbx>();
  private readonly snapshots = new Map<string, string[]>();

  constructor(private readonly apiKey: string) {}

  private sdk(): Promise<E2B> {
    return import('e2b');
  }

  private box(h: Handle): Sbx {
    const b = this.boxes.get(h.id);
    if (!b) throw new Error(`Unknown e2b sandbox ${h.id}`);
    return b;
  }

  async create(): Promise<Handle> {
    const { Sandbox } = await this.sdk();
    const sbx = await Sandbox.create({ apiKey: this.apiKey });
    this.boxes.set(sbx.sandboxId, sbx);
    return { id: sbx.sandboxId };
  }

  async exec(handle: Handle, cmd: string): Promise<ExecResult> {
    const { CommandExitError } = await this.sdk();
    try {
      const r = await this.box(handle).commands.run(cmd);
      return { exitCode: r.exitCode, stdout: r.stdout };
    } catch (err) {
      if (err instanceof CommandExitError) return { exitCode: err.exitCode, stdout: err.stdout };
      throw err;
    }
  }

  async stop(handle: Handle): Promise<void> {
    await this.box(handle).pause();
  }

  async resume(handle: Handle): Promise<void> {
    const { Sandbox } = await this.sdk();
    this.boxes.set(handle.id, await Sandbox.connect(handle.id, { apiKey: this.apiKey }));
  }

  async branch(handle: Handle, n: number): Promise<Handle[]> {
    const { Sandbox } = await this.sdk();
    const snap = await this.box(handle).createSnapshot();
    this.snapshots.set(handle.id, [...(this.snapshots.get(handle.id) ?? []), snap.snapshotId]);
    const copies = await Promise.all(
      Array.from({ length: n }, async () => {
        const sbx = await Sandbox.create(snap.snapshotId, { apiKey: this.apiKey });
        this.boxes.set(sbx.sandboxId, sbx);
        return { id: sbx.sandboxId };
      }),
    );
    return copies;
  }

  async destroy(handle: Handle): Promise<void> {
    const { Sandbox } = await this.sdk();
    this.boxes.delete(handle.id);
    await Sandbox.kill(handle.id, { apiKey: this.apiKey });
    for (const id of this.snapshots.get(handle.id) ?? []) await Sandbox.deleteSnapshot(id, { apiKey: this.apiKey });
    this.snapshots.delete(handle.id);
  }

  async info(): Promise<ProviderInfo> {
    return { version: sdkVersion('e2b') };
  }
}
