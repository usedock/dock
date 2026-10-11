import { vi } from 'vitest';
import { BadRequestException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PassThrough, Readable } from 'stream';
import { Client, CopyDestinationOptions, CopySourceOptions, InvalidArgumentError, type BucketItem } from 'minio';
import {
  FleetObjectsService,
  SNAPSHOT_STORE,
  createSnapshotStore,
  readSnapshotStoreSettings,
  snapshotStoreProvider,
  type SnapshotStore,
} from './fleet-objects.service';

const BUCKET = 'dock-snapshots';
const SNAPSHOT = 'snap-1';
const NAME = 'rootfs.ext4';

/** Config stub so the environment cannot leak into these expectations. */
function configOf(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

/** Signing client that fails if used, for paths that must not presign at all. */
function unusedPresigner(): Client {
  return new Proxy({} as Client, {
    get: () => () => {
      throw new Error('a URL was signed for an object the call must proxy');
    },
  });
}

function streamOf(body: string | Buffer): Readable {
  return Readable.from([Buffer.from(body)]);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Error shape MinIO raises for a missing key. */
function storeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * In-memory stand-in for the MinIO client. Specs assert on the objects a real
 * bucket would end up holding, so a passing test means the store state is
 * right, not merely that some mock was called.
 */
class FakeMinio {
  readonly objects = new Map<string, Buffer>();
  readonly puts: Array<{ key: string; size: number | undefined }> = [];
  readonly copied: Array<{ from: string; to: string }> = [];
  readonly composed: string[][] = [];
  composeObject?: (dest: CopyDestinationOptions, sources: CopySourceOptions[]) => Promise<unknown>;
  deleteFailures = 0;

  constructor() {
    this.composeObject = async (dest, sources) => {
      this.composed.push(sources.map((source) => source.Object));
      this.objects.set(dest.Object, Buffer.concat(this.bodies(sources.map((source) => source.Object))));
      return { etag: 'composed', versionId: null };
    };
  }

  async putObject(_bucket: string, key: string, body: Readable | Buffer | string, size?: number): Promise<unknown> {
    const buffer = Buffer.isBuffer(body)
      ? Buffer.from(body)
      : typeof body === 'string'
        ? Buffer.from(body)
        : await readAll(body);
    this.puts.push({ key, size });
    this.objects.set(key, buffer);
    return { etag: 'put', versionId: null };
  }

  async copyObject(source: CopySourceOptions, dest: CopyDestinationOptions): Promise<unknown> {
    const body = this.body(source.Object);
    this.copied.push({ from: source.Object, to: dest.Object });
    this.objects.set(dest.Object, body);
    return { etag: 'copy', versionId: null };
  }

  async getObject(_bucket: string, key: string): Promise<Readable> {
    return Readable.from([this.body(key)]);
  }

  async statObject(_bucket: string, key: string): Promise<{ size: number; etag: string; lastModified: Date; metaData: Record<string, string> }> {
    const body = this.body(key);
    return { size: body.length, etag: 'stat', lastModified: new Date(), metaData: {} };
  }

  async removeObjects(_bucket: string, keys: string[]): Promise<Array<null | { Error: { Code: string } }>> {
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      return keys.map(() => ({ Error: { Code: 'InternalError' } }));
    }
    for (const key of keys) this.objects.delete(key);
    return keys.map(() => null);
  }

  listObjectsV2(_bucket: string, prefix = ''): unknown {
    const items: BucketItem[] = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([name, body]) => ({ name, size: body.length, etag: 'list', lastModified: new Date() }));
    const stream = new PassThrough({ objectMode: true });
    setImmediate(() => {
      for (const item of items) stream.write(item);
      stream.end();
    });
    return stream;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  private body(key: string): Buffer {
    const body = this.objects.get(key);
    if (!body) throw storeError('NoSuchKey');
    return body;
  }

  private bodies(keys: string[]): Buffer[] {
    return keys.map((key) => this.body(key));
  }
}

describe('FleetObjectsService', () => {
  let fake: FakeMinio;
  let service: FleetObjectsService;

  beforeEach(() => {
    fake = new FakeMinio();
    service = new FleetObjectsService(() => ({
      client: fake as unknown as Client,
      presign: { client: unusedPresigner(), ttlSeconds: 900 },
      bucket: BUCKET,
    }));
  });

  describe('bucket encryption check', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const withClient = (client: unknown) =>
      new FleetObjectsService(() => ({
        client: client as Client,
        presign: { client: unusedPresigner(), ttlSeconds: 900, directTransfers: false },
        bucket: BUCKET,
      }));

    beforeEach(() => warn.mockClear());
    afterAll(() => warn.mockRestore());

    it('stays quiet when the bucket has default encryption', async () => {
      const client = {
        getBucketEncryption: async () => ({
          ServerSideEncryptionConfiguration: {
            Rule: { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          },
        }),
      };
      await expect(withClient(client).checkBucketEncryption()).resolves.toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns when the bucket has no encryption configuration', async () => {
      const client = {
        getBucketEncryption: async () => {
          throw storeError('ServerSideEncryptionConfigurationNotFoundError');
        },
      };
      await expect(withClient(client).checkBucketEncryption()).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no default encryption'));
    });

    it('does not claim either way when the store refuses the read', async () => {
      const client = {
        getBucketEncryption: async () => {
          throw storeError('AccessDenied');
        },
      };
      await expect(withClient(client).checkBucketEncryption()).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read'));
    });

    it('does not throw at boot when the store is unconfigured', async () => {
      const service = new FleetObjectsService(() => {
        throw new Error('SNAPSHOT_STORE_ENDPOINT is not set');
      });
      expect(() => service.onModuleInit()).not.toThrow();
      await expect(service.checkBucketEncryption()).resolves.toBeNull();
    });
  });

  describe('abandoned upload cleanup', () => {
    it('reaps parts left by an interrupted upload when a new one starts', async () => {
      // An earlier attempt died after two parts: those keys would otherwise
      // occupy the bucket forever, and a shorter retry would never overwrite
      // the higher-index leftovers.
      await fake.putObject('dock-snapshots', `snapshots/${SNAPSHOT}/${NAME}.part0`, streamOf('old'));
      await fake.putObject('dock-snapshots', `snapshots/${SNAPSHOT}/${NAME}.part1`, streamOf('old'));
      await fake.putObject('dock-snapshots', `snapshots/${SNAPSHOT}/${NAME}.part7`, streamOf('old'));

      await service.putPart(SNAPSHOT, NAME, 0, 1, 4, streamOf('AAAA'));

      const leftovers = fake.keys().filter((k) => k.includes('.part'));
      expect(leftovers).toEqual([]);
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}`]);
    });

    it('leaves another object\'s staging parts alone', async () => {
      await fake.putObject('dock-snapshots', `snapshots/${SNAPSHOT}/other.bin.part0`, streamOf('keep'));

      await service.putPart(SNAPSHOT, NAME, 0, 1, 4, streamOf('AAAA'));

      expect(fake.keys()).toContain(`snapshots/${SNAPSHOT}/other.bin.part0`);
    });
  });

  describe('putPart', () => {
    it('rejects a part outside the declared part count', async () => {
      for (const [part, parts] of [
        [2, 2],
        [3, 2],
        [-1, 2],
        [0, 0],
      ]) {
        await expect(service.putPart(SNAPSHOT, NAME, part, parts, 4, streamOf('AAAA'))).rejects.toMatchObject({
          response: { code: 'validation_error' },
        });
      }
      expect(fake.keys()).toEqual([]);
    });

    it('rejects a negative declared size', async () => {
      await expect(service.putPart(SNAPSHOT, NAME, 0, 1, -1, streamOf('AAAA'))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fake.keys()).toEqual([]);
    });

    it('stages a non-final part without publishing the object', async () => {
      const result = await service.putPart(SNAPSHOT, NAME, 0, 3, 12, streamOf('AAAA'));

      expect(result).toEqual({ complete: false, size: null });
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}.part0`]);
    });

    it('composes parts in ascending order and clears the staging parts', async () => {
      await service.putPart(SNAPSHOT, NAME, 0, 3, 12, streamOf('AAAA'));
      await service.putPart(SNAPSHOT, NAME, 1, 3, 12, streamOf('BBBB'));
      // A reader must never observe a partial object, so the target is absent
      // until the last part arrives.
      expect(fake.objects.has(`snapshots/${SNAPSHOT}/${NAME}`)).toBe(false);

      const result = await service.putPart(SNAPSHOT, NAME, 2, 3, 12, streamOf('CCCC'));

      expect(result).toEqual({ complete: true, size: 12 });
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}`]);
      expect(await readAll(await fake.getObject(BUCKET, `snapshots/${SNAPSHOT}/${NAME}`))).toEqual(
        Buffer.from('AAAABBBBCCCC'),
      );
    });

    it('copies a single part into place and leaves no staging object', async () => {
      const result = await service.putPart(SNAPSHOT, NAME, 0, 1, 4, streamOf('AAAA'));

      expect(result).toEqual({ complete: true, size: 4 });
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}`]);
      expect(fake.copied).toEqual([
        { from: `snapshots/${SNAPSHOT}/${NAME}.part0`, to: `snapshots/${SNAPSHOT}/${NAME}` },
      ]);
      expect(fake.composed).toEqual([]);
    });

    it('streams the parts in order when the store has no multipart copy', async () => {
      fake.composeObject = undefined;

      await service.putPart(SNAPSHOT, NAME, 0, 2, 8, streamOf('AAAA'));
      const result = await service.putPart(SNAPSHOT, NAME, 1, 2, 8, streamOf('BBBB'));

      expect(result).toEqual({ complete: true, size: 8 });
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}`]);
      expect(await readAll(await fake.getObject(BUCKET, `snapshots/${SNAPSHOT}/${NAME}`))).toEqual(
        Buffer.from('AAAABBBB'),
      );
      // The fallback must declare the composed length so the store cannot
      // mistake a truncated stream for a complete object.
      expect(fake.puts.at(-1)).toEqual({ key: `snapshots/${SNAPSHOT}/${NAME}`, size: 8 });
    });

    it('re-streams the parts when multipart copy refuses undersized sources', async () => {
      fake.composeObject = async () => {
        throw new InvalidArgumentError('CopySrcOptions 0 is too small (1024) and it is not the last part.');
      };

      await service.putPart(SNAPSHOT, NAME, 0, 2, 8, streamOf('AAAA'));
      const result = await service.putPart(SNAPSHOT, NAME, 1, 2, 8, streamOf('BBBB'));

      expect(result).toEqual({ complete: true, size: 8 });
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}`]);
      expect(await readAll(await fake.getObject(BUCKET, `snapshots/${SNAPSHOT}/${NAME}`))).toEqual(
        Buffer.from('AAAABBBB'),
      );
    });

    it('does not swallow a store failure behind the streaming fallback', async () => {
      fake.composeObject = async () => {
        throw Object.assign(new Error('connection closed'), { code: 'ConnectionClosed' });
      };

      const failure = service.putPart(SNAPSHOT, NAME, 1, 2, 8, streamOf('BBBB'));

      await expect(failure).rejects.toMatchObject({ code: 'ConnectionClosed' });
      expect(fake.keys()).toEqual([`snapshots/${SNAPSHOT}/${NAME}.part1`]);
    });

    it('fails loudly when the composed size does not match the declared size', async () => {
      await service.putPart(SNAPSHOT, NAME, 0, 2, 16, streamOf('AAAA'));

      const failure = service.putPart(SNAPSHOT, NAME, 1, 2, 16, streamOf('BBBB'));

      await expect(failure).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(failure).rejects.toMatchObject({ response: { code: 'size_mismatch' } });
    });

    it('fails when the staging parts cannot be removed', async () => {
      await service.putPart(SNAPSHOT, NAME, 0, 2, 8, streamOf('AAAA'));
      fake.deleteFailures = 1;

      await expect(service.putPart(SNAPSHOT, NAME, 1, 2, 8, streamOf('BBBB'))).rejects.toMatchObject({
        response: { code: 'store_error' },
      });
    });
  });

  describe('getObject', () => {
    it('returns the stored bytes and their size', async () => {
      fake.objects.set(`snapshots/${SNAPSHOT}/${NAME}`, Buffer.from('AAAA'));

      const object = await service.getObject(SNAPSHOT, NAME);

      expect(object.size).toBe(4);
      expect(await readAll(object.stream)).toEqual(Buffer.from('AAAA'));
    });

    it('reports a missing object as a 404 object_not_found', async () => {
      const failure = service.getObject(SNAPSHOT, NAME);

      await expect(failure).rejects.toBeInstanceOf(NotFoundException);
      await expect(failure).rejects.toMatchObject({ response: { code: 'object_not_found' } });
    });

    it('does not disguise a store outage as a missing object', async () => {
      fake.statObject = async () => {
        throw storeError('ConnectionClosed');
      };

      await expect(service.getObject(SNAPSHOT, NAME)).rejects.toMatchObject({ code: 'ConnectionClosed' });
    });
  });

  describe('presignObject', () => {
    const credentials = { SNAPSHOT_STORE_ACCESS_KEY: 'key', SNAPSHOT_STORE_SECRET_KEY: 'secret' };
    const objectPath = `/${BUCKET}/snapshots/${SNAPSHOT}/${NAME}`;

    /** Service over real clients: signing is offline, so no request leaves the test. */
    const serviceFor = (env: Record<string, string>) =>
      new FleetObjectsService(() => createSnapshotStore(configOf({ ...credentials, ...env })));

    it('signs a direct PUT that names the bucket and the object key', async () => {
      const result = await serviceFor({
        SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000',
        SNAPSHOT_STORE_PUBLIC_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      }).presignObject(
        SNAPSHOT,
        NAME,
        'put',
        64 * 1024 * 1024,
      );

      expect(result.mode).toBe('direct');
      expect(result.expiresInSeconds).toBe(900);
      const url = new URL(result.url);
      expect(url.protocol).toBe('https:');
      expect(url.pathname).toBe(objectPath);
    });

    it('falls back to the proxy for an object one PUT cannot carry', async () => {
      const proxying = new FleetObjectsService(() => ({
        client: fake as unknown as Client,
        presign: { client: unusedPresigner(), ttlSeconds: 900 },
        bucket: BUCKET,
      }));

      // 5 GiB is the store's single-PUT ceiling, so the object has to travel
      // through the chunked part routes instead of failing the upload.
      const result = await proxying.presignObject(SNAPSHOT, NAME, 'put', 5 * 1024 ** 3);

      expect(result).toEqual({ mode: 'proxy', url: '', expiresInSeconds: 0 });
    });

    it('signs a direct GET whatever the object size', async () => {
      const presigning = serviceFor({
        SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000',
        SNAPSHOT_STORE_PUBLIC_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      });

      const withoutSize = await presigning.presignObject(SNAPSHOT, NAME, 'get');
      const huge = await presigning.presignObject(SNAPSHOT, NAME, 'get', 5 * 1024 ** 3);

      expect(withoutSize.mode).toBe('direct');
      expect(huge.mode).toBe('direct');
      expect(new URL(huge.url).pathname).toBe(objectPath);
      expect(huge.expiresInSeconds).toBe(900);
    });

    it('expires the URL after the configured lifetime', async () => {
      const result = await serviceFor({
        SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000',
        SNAPSHOT_STORE_PUBLIC_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
        SNAPSHOT_STORE_PRESIGN_TTL_SECONDS: '60',
      }).presignObject(SNAPSHOT, NAME, 'put', 1024);

      expect(result.expiresInSeconds).toBe(60);
    });

    it('signs against the public endpoint, the only address a host can dial', async () => {
      const result = await serviceFor({
        SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000',
        SNAPSHOT_STORE_PUBLIC_ENDPOINT: 'https://s3.example.com',
      }).presignObject(SNAPSHOT, NAME, 'put', 1024);

      const url = new URL(result.url);
      expect(url.host).toBe('s3.example.com');
      expect(url.protocol).toBe('https:');
      expect(url.pathname).toBe(objectPath);
    });

    it('stays on the proxy when no host-reachable endpoint is configured', async () => {
      // The default store is an in-compose MinIO: a URL signed against it would
      // name a hostname no host can resolve, so signing must not happen.
      const result = await serviceFor({ SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000' }).presignObject(
        SNAPSHOT,
        NAME,
        'put',
        1024,
      );

      expect(result).toEqual({ mode: 'proxy', url: '', expiresInSeconds: 0 });
    });

    it('stays on the proxy for a GET when no host-reachable endpoint is configured', async () => {
      const result = await serviceFor({ SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000' }).presignObject(
        SNAPSHOT,
        NAME,
        'get',
      );

      expect(result).toEqual({ mode: 'proxy', url: '', expiresInSeconds: 0 });
    });

    it('rejects a PUT that declares no size', async () => {
      await expect(
        serviceFor({
          SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000',
          SNAPSHOT_STORE_PUBLIC_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
        }).presignObject(
          SNAPSHOT,
          NAME,
          'put',
        ),
      ).rejects.toMatchObject({ response: { code: 'validation_error' } });
    });
  });

  describe('deleteGeneration', () => {
    it('deletes only the requested generation and reports the count', async () => {
      fake.objects.set(`snapshots/${SNAPSHOT}/${NAME}`, Buffer.from('AAAA'));
      fake.objects.set(`snapshots/${SNAPSHOT}/${NAME}.part1`, Buffer.from('BBBB'));
      fake.objects.set('snapshots/snap-2/other', Buffer.from('CCCC'));

      const result = await service.deleteGeneration(SNAPSHOT);

      expect(result).toEqual({ deleted: 2 });
      expect(fake.keys()).toEqual(['snapshots/snap-2/other']);
    });

    it('reports zero for a generation that stored nothing', async () => {
      expect(await service.deleteGeneration(SNAPSHOT)).toEqual({ deleted: 0 });
    });
  });

  describe('listGeneration', () => {
    it('strips the prefix and sorts by path', async () => {
      fake.objects.set(`snapshots/${SNAPSHOT}/z.txt`, Buffer.from('zz'));
      fake.objects.set(`snapshots/${SNAPSHOT}/dir/a.txt`, Buffer.from('a'));
      fake.objects.set('snapshots/snap-2/other.txt', Buffer.from('other'));

      expect(await service.listGeneration(SNAPSHOT)).toEqual({
        files: [
          { path: 'dir/a.txt', size: 1 },
          { path: 'z.txt', size: 2 },
        ],
      });
    });

    it('returns nothing for an unknown generation', async () => {
      expect(await service.listGeneration('snap-missing')).toEqual({ files: [] });
    });
  });

  it('builds the store once, on first use', async () => {
    let builds = 0;
    const lazy = new FleetObjectsService(() => {
      builds += 1;
      return {
        client: fake as unknown as Client,
        presign: { client: unusedPresigner(), ttlSeconds: 900 },
        bucket: BUCKET,
      };
    });

    expect(builds).toBe(0);
    await lazy.listGeneration(SNAPSHOT);
    await lazy.listGeneration(SNAPSHOT);

    expect(builds).toBe(1);
  });
});

describe('readSnapshotStoreSettings', () => {
  /** Stub config so the environment cannot leak into these expectations. */
  const settings = (env: Record<string, string>) => readSnapshotStoreSettings(configOf(env));

  const credentials = { SNAPSHOT_STORE_ACCESS_KEY: 'key', SNAPSHOT_STORE_SECRET_KEY: 'secret' };

  it('splits the host and port out of an endpoint that carries a scheme', () => {
    expect(settings({ SNAPSHOT_STORE_ENDPOINT: 'http://minio:9000', ...credentials })).toEqual({
      endPoint: 'minio',
      port: 9000,
      useSSL: false,
      publicEndPoint: 'minio',
      publicPort: 9000,
      publicUseSSL: false,
      region: 'us-east-1',
      pathStyle: true,
      presignTtlSeconds: 900,
      directTransfers: false,
      accessKey: 'key',
      secretKey: 'secret',
      bucket: 'dock-snapshots',
    });
  });

  it('defaults the port from the scheme and lets the ssl flag win', () => {
    expect(
      settings({ SNAPSHOT_STORE_ENDPOINT: 'https://s3.example', SNAPSHOT_STORE_SSL: 'false', ...credentials }),
    ).toMatchObject({ endPoint: 's3.example', port: 443, useSSL: false });
  });

  it('accepts a bare host:port endpoint', () => {
    expect(settings({ SNAPSHOT_STORE_ENDPOINT: '10.0.0.5:9000', ...credentials })).toMatchObject({
      endPoint: '10.0.0.5',
      port: 9000,
      useSSL: false,
    });
  });

  it('prefers the configured bucket over the default', () => {
    expect(
      settings({
        SNAPSHOT_STORE_ENDPOINT: 'http://minio:9000',
        SNAPSHOT_STORE_BUCKET: 'other-bucket',
        ...credentials,
      }).bucket,
    ).toBe('other-bucket');
  });

  it('takes the host-reachable endpoint and presign knobs when configured', () => {
    expect(
      settings({
        SNAPSHOT_STORE_ENDPOINT: 'http://backend-minio:9000',
        SNAPSHOT_STORE_PUBLIC_ENDPOINT: 'https://s3.example.com',
        SNAPSHOT_STORE_REGION: 'eu-west-1',
        SNAPSHOT_STORE_PATH_STYLE: 'false',
        SNAPSHOT_STORE_PRESIGN_TTL_SECONDS: '60',
        ...credentials,
      }),
    ).toMatchObject({
      endPoint: 'backend-minio',
      publicEndPoint: 's3.example.com',
      publicPort: 443,
      publicUseSSL: true,
      region: 'eu-west-1',
      pathStyle: false,
      presignTtlSeconds: 60,
    });
  });

  it('ignores a presign lifetime that is not a positive whole number of seconds', () => {
    expect(
      settings({ SNAPSHOT_STORE_ENDPOINT: 'http://minio:9000', SNAPSHOT_STORE_PRESIGN_TTL_SECONDS: 'soon', ...credentials }),
    ).toMatchObject({ presignTtlSeconds: 900 });
  });

  it('names the missing setting instead of dialling an incomplete store', () => {
    expect(() => settings({ SNAPSHOT_STORE_ENDPOINT: 'http://minio:9000' })).toThrow(
      /SNAPSHOT_STORE_ACCESS_KEY is not configured/,
    );
    expect(() => settings({ SNAPSHOT_STORE_ENDPOINT: 'not a url' })).toThrow(/not a valid endpoint/);
  });
});

describe('snapshotStoreProvider', () => {
  it('hands the service a factory that builds the configured store', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        FleetObjectsService,
        snapshotStoreProvider,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SNAPSHOT_STORE_ENDPOINT: 'https://s3.example:9443',
            SNAPSHOT_STORE_ACCESS_KEY: 'key',
            SNAPSHOT_STORE_SECRET_KEY: 'secret',
          }),
        },
      ],
    }).compile();

    // The token must carry a callable: the service invokes it on first use.
    const build = moduleRef.get<() => SnapshotStore>(SNAPSHOT_STORE);
    expect(typeof build).toBe('function');
    const store = build();
    expect(store.client).toBeInstanceOf(Client);
    expect(store.presign.client).toBeInstanceOf(Client);
    expect(store.bucket).toBe('dock-snapshots');
    expect(moduleRef.get(FleetObjectsService)).toBeInstanceOf(FleetObjectsService);
  });
});
