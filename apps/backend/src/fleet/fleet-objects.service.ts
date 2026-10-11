import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client,
  CopyDestinationOptions,
  CopySourceOptions,
  InvalidArgumentError,
  type BucketItem,
  type BucketItemStat,
  type BucketStream,
} from 'minio';
import { Readable } from 'stream';

/** Snapshot store handle: one MinIO client plus the bucket generations live in. */
export interface SnapshotStore {
  client: Client;
  /**
   * Signing client and URL lifetime; it names the address a host dials.
   * `directTransfers` is false when there is no such address, in which case
   * `client` is never consulted.
   */
  presign: { client: Client; ttlSeconds: number; directTransfers: boolean };
  bucket: string;
}

/** Builds the store on first use; specs replace it so no test touches the network. */
export type SnapshotStoreFactory = () => SnapshotStore;

export const SNAPSHOT_STORE = 'SNAPSHOT_STORE';

/** Object keys are `snapshots/<snapshotId>/<name>`; see the fleet contract doc. */
const KEY_PREFIX = 'snapshots';
const DEFAULT_BUCKET = 'dock-snapshots';
/** SigV4 always signs in a region; a non-AWS store ignores it. */
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_PRESIGN_TTL_SECONDS = 900;
/** S3 refuses a single PUT above 5 GiB, so the direct path stops a margin short. */
const DIRECT_PUT_MAX = 5 * 1024 ** 3 - 1024 ** 2;
/** MinIO reports a missing key by error code rather than by HTTP status. */
const NOT_FOUND_CODES = ['NoSuchKey', 'NotFound', 'NoSuchObject'];
/** What S3 and MinIO answer when a bucket has no default encryption configured. */
const NO_ENCRYPTION_CODES = ['ServerSideEncryptionConfigurationNotFoundError'];

export interface SnapshotStoreSettings {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  /** Host-reachable address; only URL signing uses it. */
  publicEndPoint: string;
  publicPort: number;
  publicUseSSL: boolean;
  region: string;
  pathStyle: boolean;
  presignTtlSeconds: number;
  /**
   * Whether hosts may be handed signed URLs at all. Only an explicitly
   * configured public endpoint enables it: the default store is an in-compose
   * MinIO whose hostname no host can resolve, so signing against it
   * would hand out URLs that always fail.
   */
  directTransfers: boolean;
}

/**
 * Parses the SNAPSHOT_STORE_* env. A missing key throws here, on first use,
 * so a machine without store credentials still boots and serves the rest.
 */
export function readSnapshotStoreSettings(config: ConfigService): SnapshotStoreSettings {
  const internal = endpointParts(
    requireSetting(config, 'SNAPSHOT_STORE_ENDPOINT'),
    'SNAPSHOT_STORE_ENDPOINT',
    config.get<string>('SNAPSHOT_STORE_SSL'),
  );
  const publicRaw = config.get<string>('SNAPSHOT_STORE_PUBLIC_ENDPOINT')?.trim();
  // A host cannot resolve an in-compose name such as `backend-minio:9000`, so a
  // signed URL must name the endpoint that host itself reaches. Without one
  // there is no address to sign against, and transfers stay on the proxy.
  const external = publicRaw ? endpointParts(publicRaw, 'SNAPSHOT_STORE_PUBLIC_ENDPOINT') : internal;
  const ttl = Number(config.get<string>('SNAPSHOT_STORE_PRESIGN_TTL_SECONDS'));
  return {
    ...internal,
    publicEndPoint: external.endPoint,
    publicPort: external.port,
    publicUseSSL: external.useSSL,
    region: config.get<string>('SNAPSHOT_STORE_REGION')?.trim() || DEFAULT_REGION,
    // MinIO needs path-style addressing and S3 accepts it, so only an explicit
    // `false` turns it off.
    pathStyle: config.get<string>('SNAPSHOT_STORE_PATH_STYLE') !== 'false',
    presignTtlSeconds: Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_PRESIGN_TTL_SECONDS,
    directTransfers: Boolean(publicRaw),
    accessKey: requireSetting(config, 'SNAPSHOT_STORE_ACCESS_KEY'),
    secretKey: requireSetting(config, 'SNAPSHOT_STORE_SECRET_KEY'),
    bucket: config.get<string>('SNAPSHOT_STORE_BUCKET')?.trim() || DEFAULT_BUCKET,
  };
}

/**
 * Client for the central snapshot bucket, plus the signer hosts use. The first
 * client talks to the configured store endpoint (how the control plane reads
 * objects itself); the second signs URLs against the host-reachable endpoint.
 */
export function createSnapshotStore(config: ConfigService): SnapshotStore {
  const settings = readSnapshotStoreSettings(config);
  return {
    client: new Client({
      endPoint: settings.endPoint,
      port: settings.port,
      useSSL: settings.useSSL,
      accessKey: settings.accessKey,
      secretKey: settings.secretKey,
    }),
    presign: {
      client: new Client({
        endPoint: settings.publicEndPoint,
        port: settings.publicPort,
        useSSL: settings.publicUseSSL,
        region: settings.region,
        pathStyle: settings.pathStyle,
        accessKey: settings.accessKey,
        secretKey: settings.secretKey,
      }),
      ttlSeconds: settings.presignTtlSeconds,
      directTransfers: settings.directTransfers,
    },
    bucket: settings.bucket,
  };
}

/**
 * DI registration for the deferred factory. Exported so the module and its
 * specs share one definition: the token must resolve to a function, never to
 * a ready-made store, or every object route fails on first use.
 */
export const snapshotStoreProvider: Provider = {
  provide: SNAPSHOT_STORE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): SnapshotStoreFactory => () => createSnapshotStore(config),
};

export type PresignOp = 'put' | 'get';

/** How a host should move one object: straight to the store, or through the proxy. */
export interface PresignResult {
  mode: 'direct' | 'proxy';
  url: string;
  expiresInSeconds: number;
}

/**
 * Generation objects on behalf of hosts: parts arrive over the fleet
 * API and are composed in the store, so a host never holds bucket credentials
 * and a reader never observes a half-uploaded generation.
 */
@Injectable()
export class FleetObjectsService implements OnModuleInit {
  private readonly logger = new Logger(FleetObjectsService.name);
  private connection?: SnapshotStore;

  constructor(@Inject(SNAPSHOT_STORE) private readonly createStore: SnapshotStoreFactory) {}

  /**
   * Warns at boot when the snapshot bucket has no default encryption. Never
   * awaited and never throws: a store that is down, unconfigured or hides the
   * setting from this key must not stop the API from starting.
   */
  onModuleInit(): void {
    void this.checkBucketEncryption();
  }

  /** Resolves true (encrypted), false (not encrypted) or null (could not tell). */
  async checkBucketEncryption(): Promise<boolean | null> {
    let store: SnapshotStore;
    try {
      store = this.store;
    } catch {
      // No store settings: nothing to check, and object routes report it on use.
      return null;
    }
    try {
      const config = await store.client.getBucketEncryption(store.bucket);
      if (JSON.stringify(config ?? {}).includes('SSEAlgorithm')) return true;
    } catch (error) {
      if (!hasCode(error, NO_ENCRYPTION_CODES)) {
        this.logger.warn(
          `could not read default encryption of snapshot bucket ${store.bucket}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }
    this.logger.warn(
      `snapshot bucket ${store.bucket} has no default encryption, so Snapshots are stored unencrypted; ` +
        'enable SSE-S3 or SSE-KMS on the bucket (see the self-hosting docs)',
    );
    return false;
  }

  private get store(): SnapshotStore {
    // Constructed on first use so a missing store config cannot fail boot.
    return (this.connection ??= this.createStore());
  }

  /**
   * Stores one part. The last part composes the parts in order into the final
   * object and drops the staging copies, so the object appears only complete.
   */
  async putPart(
    snapshotId: string,
    name: string,
    part: number,
    parts: number,
    size: number,
    body: Readable,
  ): Promise<{ complete: boolean; size: number | null }> {
    if (!Number.isInteger(parts) || parts < 1 || !Number.isInteger(part) || part < 0 || part >= parts) {
      throw new BadRequestException({ code: 'validation_error', message: 'part must satisfy 0 <= part < parts' });
    }
    if (!Number.isInteger(size) || size < 0) {
      throw new BadRequestException({ code: 'validation_error', message: 'size must be a non-negative byte count' });
    }
    const { client, bucket } = this.store;
    const target = this.objectKey(snapshotId, name);
    const staged = this.partKey(snapshotId, name, part);
    // A part-0 write starts a fresh upload, so anything staged by an earlier
    // attempt is abandoned: an interrupted upload (host crash, timeout, dropped
    // connection) otherwise leaves its parts in the bucket forever, and a retry
    // with fewer parts would never overwrite the higher-index leftovers.
    if (part === 0) await this.reapStagedParts(client, bucket, snapshotId, name);
    await client.putObject(bucket, staged, body);
    if (part !== parts - 1) return { complete: false, size: null };

    const stagedKeys = Array.from({ length: parts }, (_unused, index) => this.partKey(snapshotId, name, index));
    await this.compose(client, bucket, target, stagedKeys);
    const composed = await client.statObject(bucket, target);
    // A host that miscounted its bytes must not publish a truncated object.
    if (size > 0 && composed.size !== size) {
      throw new InternalServerErrorException({
        code: 'size_mismatch',
        message: `composed object is ${composed.size} bytes, expected ${size}`,
      });
    }
    await this.removeMany(client, bucket, stagedKeys, 'staging parts could not be removed');
    return { complete: true, size: composed.size };
  }

  /**
   * Coordinates for one object. A direct answer hands the host a presigned URL
   * so its bytes never cross the control plane; an upload too large for a single
   * PUT reports `proxy` and the host falls back to the chunked part routes.
   */
  async presignObject(snapshotId: string, name: string, op: PresignOp, size?: number): Promise<PresignResult> {
    // No host-reachable store address means no usable URL, so keep the proxy
    // rather than failing every transfer.
    if (!this.store.presign.directTransfers) return { mode: 'proxy', url: '', expiresInSeconds: 0 };
    if (op === 'put') {
      if (size === undefined || !Number.isInteger(size) || size < 0) {
        throw new BadRequestException({
          code: 'validation_error',
          message: 'size must be a non-negative byte count when uploading',
        });
      }
      // The store would refuse the PUT outright, so the artifact still travels
      // through the proxy instead of failing the upload.
      if (size > DIRECT_PUT_MAX) return { mode: 'proxy', url: '', expiresInSeconds: 0 };
    }
    const { presign, bucket } = this.store;
    const key = this.objectKey(snapshotId, name);
    // A presigned GET carries no size, so a download is always direct.
    const url =
      op === 'put'
        ? await presign.client.presignedPutObject(bucket, key, presign.ttlSeconds)
        : await presign.client.presignedGetObject(bucket, key, presign.ttlSeconds);
    return { mode: 'direct', url, expiresInSeconds: presign.ttlSeconds };
  }

  /** Streams an assembled object, or reports a missing one as a host-facing 404. */
  async getObject(snapshotId: string, name: string): Promise<{ stream: Readable; size: number }> {
    const { client, bucket } = this.store;
    const key = this.objectKey(snapshotId, name);
    let stat: BucketItemStat;
    try {
      stat = await client.statObject(bucket, key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throw new NotFoundException({ code: 'object_not_found', message: `no such object: ${name}` });
    }
    return { stream: await client.getObject(bucket, key), size: stat.size };
  }

  /** Drops staging parts left behind by an interrupted upload of one object. */
  private async reapStagedParts(
    client: Client,
    bucket: string,
    snapshotId: string,
    name: string,
  ): Promise<void> {
    const prefix = `${this.objectKey(snapshotId, name)}.part`;
    const stale: string[] = [];
    for await (const obj of client.listObjectsV2(bucket, prefix, true)) {
      if (obj.name) stale.push(obj.name);
    }
    // Best effort: a failed reap must not block the upload it is protecting.
    if (stale.length > 0) await this.removeMany(client, bucket, stale, 'stale parts could not be removed');
  }

  /** Removes every object of one generation, staging parts included. */
  async deleteGeneration(snapshotId: string): Promise<{ deleted: number }> {
    const { client, bucket } = this.store;
    const keys = await this.listKeys(client, bucket, this.prefix(snapshotId));
    if (keys.length === 0) return { deleted: 0 };
    await this.removeMany(client, bucket, keys, 'generation could not be removed');
    return { deleted: keys.length };
  }

  /** Files of one generation, relative to its prefix, ordered by path. */
  async listGeneration(snapshotId: string): Promise<{ files: Array<{ path: string; size: number }> }> {
    const { client, bucket } = this.store;
    const prefix = this.prefix(snapshotId);
    const files: Array<{ path: string; size: number }> = [];
    await this.eachObject(client, bucket, prefix, (name, size) => {
      files.push({ path: name.slice(prefix.length), size });
    });
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { files };
  }

  /** Copies a single part across, or composes several in the order given. */
  private async compose(client: Client, bucket: string, target: string, staged: string[]): Promise<void> {
    if (staged.length === 1) {
      await client.copyObject(
        new CopySourceOptions({ Bucket: bucket, Object: staged[0] }),
        new CopyDestinationOptions({ Bucket: bucket, Object: target }),
      );
      return;
    }
    if (typeof client.composeObject === 'function') {
      try {
        const result = await client.composeObject(
          new CopyDestinationOptions({ Bucket: bucket, Object: target }),
          staged.map((key) => new CopySourceOptions({ Bucket: bucket, Object: key })),
        );
        if (result !== false) return;
        throw new InternalServerErrorException({ code: 'store_error', message: 'store refused to compose the parts' });
      } catch (error) {
        // Multipart copy refuses sources under its 5MiB floor, which is the
        // host's choice of part size rather than a store fault, so the parts
        // are re-streamed instead of failing the upload.
        if (!isUndersizedSource(error)) throw error;
      }
    }
    // Some S3-compatible stores lack multipart copy; re-stream the parts in
    // order instead, so the composed object is still written in one shot.
    const stats = await Promise.all(staged.map((key) => client.statObject(bucket, key)));
    const total = stats.reduce((sum, stat) => sum + stat.size, 0);
    await client.putObject(bucket, target, concatParts(client, bucket, staged), total);
  }

  private async listKeys(client: Client, bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    await this.eachObject(client, bucket, prefix, (name) => keys.push(name));
    return keys;
  }

  /** Drains a recursive listing; only object entries (never prefixes) arrive. */
  private async eachObject(
    client: Client,
    bucket: string,
    prefix: string,
    visit: (name: string, size: number) => void,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream: BucketStream<BucketItem> = client.listObjectsV2(bucket, prefix, true);
      stream.on('data', (item: BucketItem) => {
        if (typeof item.name === 'string') visit(item.name, item.size);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
  }

  private async removeMany(client: Client, bucket: string, keys: string[], message: string): Promise<void> {
    const responses = await client.removeObjects(bucket, keys);
    // Quiet deletes report failures only, so any entry means the removal failed.
    if (responses.some((entry) => entry?.Error !== undefined)) {
      throw new InternalServerErrorException({ code: 'store_error', message });
    }
  }

  private prefix(snapshotId: string): string {
    return `${KEY_PREFIX}/${snapshotId}/`;
  }

  private objectKey(snapshotId: string, name: string): string {
    return `${this.prefix(snapshotId)}${name}`;
  }

  private partKey(snapshotId: string, name: string, part: number): string {
    return `${this.objectKey(snapshotId, name)}.part${part}`;
  }
}

/** Reads staged parts back in order as one stream. */
function concatParts(client: Client, bucket: string, keys: string[]): Readable {
  return Readable.from(
    (async function* readParts() {
      for (const key of keys) yield* await client.getObject(bucket, key);
    })(),
  );
}

function requireSetting(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim();
  // The message names the key only: store coordinates never leave the control plane.
  if (!value) {
    throw new InternalServerErrorException({ code: 'store_unconfigured', message: `${key} is not configured` });
  }
  return value;
}

/** Accepts `host:port`, `http://host:port` and `https://host`. */
function parseEndpoint(raw: string, key: string): URL {
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    throw new InternalServerErrorException({
      code: 'store_unconfigured',
      message: `${key} is not a valid endpoint`,
    });
  }
}

/** Client coordinates for one configured address, port and scheme resolved. */
function endpointParts(raw: string, key: string, ssl?: string): { endPoint: string; port: number; useSSL: boolean } {
  const endpoint = parseEndpoint(raw, key);
  return {
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    // An explicit flag wins; otherwise the endpoint scheme decides.
    useSSL: ssl ? ssl === 'true' : endpoint.protocol === 'https:',
  };
}

function hasCode(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, NOT_FOUND_CODES);
}

/** True when multipart copy rejected a source below its minimum part size. */
function isUndersizedSource(error: unknown): boolean {
  return error instanceof InvalidArgumentError && error.message.includes('is too small');
}
