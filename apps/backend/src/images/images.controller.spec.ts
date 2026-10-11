import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

const names = ['ubuntu-24.04', 'node-22', 'python-3.12', 'browser'];

describe('ImagesController', () => {
  it('returns the catalog with the default image available while a host is online', async () => {
    const hosts = { listOnline: vi.fn().mockResolvedValue([{ id: 'h1', images: null }]) };
    const list = await new ImagesController(new ImagesService(hosts as never)).list();
    expect(list.map((i) => i.name)).toEqual(names);
    expect(list.filter((i) => i.available).map((i) => i.name)).toEqual(['ubuntu-24.04']);
    expect(list[0]).toMatchObject({ arch: ['amd64', 'arm64'], sizeMiB: 2048 });
    expect(list[0].description).toContain('Ubuntu 24.04');
  });

  // Read from source: importing AppModule validates the process env.
  it('is mounted by the app module', () => {
    const imports = /imports:\s*\[([\s\S]*?)\n  \]/.exec(readFileSync(join(__dirname, '../app.module.ts'), 'utf8'))?.[1] ?? '';
    expect(imports).toMatch(/^\s*ImagesModule,$/m);
  });

  it('marks an image available when an online host reports it', async () => {
    const hosts = { listOnline: vi.fn().mockResolvedValue([{ id: 'a', images: null }, { id: 'b', images: ['node-22', 'ubuntu-24.04'] }]) };
    const list = await new ImagesService(hosts as never).list();
    expect(list.filter((i) => i.available).map((i) => i.name)).toEqual(['ubuntu-24.04', 'node-22']);
  });

  it('does not offer the default image from a host that reports an empty list', async () => {
    const hosts = { listOnline: vi.fn().mockResolvedValue([{ id: 'a', images: [] }]) };
    const list = await new ImagesService(hosts as never).list();
    expect(list.every((i) => !i.available)).toBe(true);
  });

  it('marks every image unavailable with no online host', async () => {
    const hosts = { listOnline: vi.fn().mockResolvedValue([]) };
    const list = await new ImagesService(hosts as never).list();
    expect(list.every((i) => !i.available)).toBe(true);
  });
});
