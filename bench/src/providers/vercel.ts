import { createAll } from './settle.ts';
import { sdkVersion } from './sdk-version.ts';
import type { ExecResult, Handle, Provider, ProviderInfo, Size } from './types.ts';

type Vercel = typeof import('@vercel/sandbox');
type Sbx = import('@vercel/sandbox').Sandbox;

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

export class VercelProvider implements Provider {
  readonly name = 'vercel';
  readonly supports = { stopResume: true, branch: true };
  private readonly boxes = new Map<string, Sbx>();
  private readonly snapshots = new Map<string, string[]>();

  constructor(private readonly creds: VercelCredentials) {}

  private sdk(): Promise<Vercel> {
    return import('@vercel/sandbox');
  }

  async prepare(): Promise<void> {
    await this.sdk();
  }

  private box(h: Handle): Sbx {
    const b = this.boxes.get(h.id);
    if (!b) throw new Error(`Unknown vercel sandbox ${h.id}`);
    return b;
  }

  async create(size?: Size): Promise<Handle> {
    const { Sandbox } = await this.sdk();
    const sbx = await Sandbox.create({ ...this.creds, ...(size ? { resources: { vcpus: size.cpus } } : {}) });
    this.boxes.set(sbx.name, sbx);
    return { id: sbx.name };
  }

  async exec(handle: Handle, cmd: string): Promise<ExecResult> {
    const r = await this.box(handle).runCommand('bash', ['-lc', cmd]);
    return { exitCode: r.exitCode, stdout: await r.stdout() };
  }

  async stop(handle: Handle): Promise<void> {
    await this.box(handle).stop();
  }

  // A stopped persistent sandbox resumes by name.
  async resume(handle: Handle): Promise<void> {
    const { Sandbox } = await this.sdk();
    this.boxes.set(handle.id, await Sandbox.get({ ...this.creds, name: handle.id, resume: true }));
  }

  async branch(handle: Handle, n: number): Promise<Handle[]> {
    const { Sandbox } = await this.sdk();
    const snap = await this.box(handle).snapshot();
    this.snapshots.set(handle.id, [...(this.snapshots.get(handle.id) ?? []), snap.snapshotId]);
    return createAll(
      n,
      async () => {
        const sbx = await Sandbox.create({ ...this.creds, source: { type: 'snapshot', snapshotId: snap.snapshotId } });
        this.boxes.set(sbx.name, sbx);
        return { id: sbx.name };
      },
      (c) => this.destroy(c),
    );
  }

  async destroy(handle: Handle): Promise<void> {
    // Forget the handle only after the delete succeeds, so cleanup can retry it.
    await this.box(handle).delete({ deleteOrphanSnapshots: true });
    this.boxes.delete(handle.id);
    const { Snapshot } = await this.sdk();
    for (const snapshotId of this.snapshots.get(handle.id) ?? []) {
      const snap = await Snapshot.get({ ...this.creds, snapshotId });
      await snap.delete();
    }
    this.snapshots.delete(handle.id);
  }

  async info(): Promise<ProviderInfo> {
    return { version: sdkVersion('@vercel/sandbox') };
  }
}
