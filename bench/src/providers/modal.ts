import { createAll } from './settle.ts';
import { sdkVersion } from './sdk-version.ts';
import { UnsupportedError, type ExecResult, type Handle, type Provider, type ProviderInfo } from './types.ts';

type ModalSdk = typeof import('modal');
type Sbx = Awaited<ReturnType<InstanceType<ModalSdk['ModalClient']>['sandboxes']['create']>>;
type Image = ReturnType<InstanceType<ModalSdk['ModalClient']>['images']['fromRegistry']>;

const BASE_IMAGE = 'debian:bookworm-slim';

export class ModalProvider implements Provider {
  readonly name = 'modal';
  // Sandboxes have no pause; branching goes through filesystem snapshots.
  readonly supports = { stopResume: false, branch: true };
  private readonly boxes = new Map<string, Sbx>();
  private client?: InstanceType<ModalSdk['ModalClient']>;
  private app?: Awaited<ReturnType<InstanceType<ModalSdk['ModalClient']>['apps']['fromName']>>;

  constructor(private readonly creds: { tokenId: string; tokenSecret: string }) {}

  private async ctx() {
    if (!this.client) {
      const { ModalClient } = await import('modal');
      this.client = new ModalClient(this.creds);
      this.app = await this.client.apps.fromName('dock-bench', { createIfMissing: true });
    }
    return { client: this.client, app: this.app! };
  }

  async prepare(): Promise<void> {
    await this.ctx();
  }

  private box(h: Handle): Sbx {
    const b = this.boxes.get(h.id);
    if (!b) throw new Error(`Unknown modal sandbox ${h.id}`);
    return b;
  }

  private async start(image: Image | Awaited<ReturnType<Sbx['snapshotFilesystem']>>): Promise<Handle> {
    const { client, app } = await this.ctx();
    const sbx = await client.sandboxes.create(app, image);
    this.boxes.set(sbx.sandboxId, sbx);
    return { id: sbx.sandboxId };
  }

  async create(): Promise<Handle> {
    const { client } = await this.ctx();
    return this.start(client.images.fromRegistry(BASE_IMAGE));
  }

  async exec(handle: Handle, cmd: string): Promise<ExecResult> {
    const p = await this.box(handle).exec(['bash', '-lc', cmd]);
    const [stdout, exitCode] = await Promise.all([p.stdout.readText(), p.wait()]);
    return { exitCode, stdout };
  }

  async stop(): Promise<void> {
    throw new UnsupportedError('modal sandboxes cannot be stopped and resumed');
  }

  async resume(): Promise<void> {
    throw new UnsupportedError('modal sandboxes cannot be stopped and resumed');
  }

  async branch(handle: Handle, n: number): Promise<Handle[]> {
    const image = await this.box(handle).snapshotFilesystem();
    return createAll(n, () => this.start(image), (c) => this.destroy(c));
  }

  async destroy(handle: Handle): Promise<void> {
    // Forget the handle only after terminate succeeds, so cleanup can retry it.
    await this.box(handle).terminate();
    this.boxes.delete(handle.id);
  }

  async info(): Promise<ProviderInfo> {
    return { version: sdkVersion('modal') };
  }
}
