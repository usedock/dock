import { ForbiddenException, HttpException } from '@nestjs/common';
import { vi } from 'vitest';
import { FakeComputeProvider } from '../docks/compute.provider';
import { DockNotFoundException } from '../docks/dock-errors';
import { ConnectorAdminOnlyException } from '../connectors/connectors.service';
import { EnvironmentSecretsAdminOnlyException } from '../environments/environments.service';
import { WorkspaceNotFoundException } from '../workspaces/workspaces.service';
import { DockTransfersService, MAX_PROXY_BYTES_IN_FLIGHT, MAX_PROXY_PARTS_PER_ORG, parseRange, partSizeFor, wholeImageManifest } from './dock-transfers.service';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const SHA = 'a'.repeat(64);

describe('DockTransfersService', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const wsId = '22222222-2222-4222-8222-222222222222';
  const dockId = '33333333-3333-4333-8333-333333333333';
  const importId = '44444444-4444-4444-8444-444444444444';
  const exportId = '55555555-5555-4555-8555-555555555555';

  let db: any;
  let orgs: any;
  let workspaces: any;
  let docks: any;
  let envs: any;
  let objects: any;
  let hosts: any;
  let retention: any;
  let config: any;
  let provider: FakeComputeProvider;
  let service: DockTransfersService;
  let inserted: Array<Record<string, unknown>>;
  let updated: Array<Record<string, unknown>>;

  const importRow = (overrides: Record<string, unknown> = {}) => ({
    id: importId,
    organizationId: orgId,
    workspaceId: wsId,
    createdBy: 'u1',
    name: null,
    image: 'ubuntu-24.04',
    cpus: 2,
    memoryMiB: 4096,
    diskGiB: 20,
    sizeBytes: 5 * MIB,
    sha256: SHA,
    storeSnapshotId: 'gen-1',
    uploadId: 'up-1',
    mode: 'direct',
    partSize: 16 * MIB,
    partCount: 1,
    status: 'uploading',
    error: null,
    dockId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
    ...overrides,
  });
  const exportRow = (overrides: Record<string, unknown> = {}) => ({
    id: exportId,
    organizationId: orgId,
    dockId,
    createdBy: 'u1',
    state: 'pending',
    error: null,
    image: 'ubuntu-24.04',
    cpus: 2,
    memoryMiB: 4096,
    diskGiB: 20,
    sizeBytes: null,
    sha256: null,
    baseImage: null,
    storeSnapshotId: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  });
  const dockRow = (overrides: Record<string, unknown> = {}) => ({
    id: dockId,
    workspaceId: wsId,
    runtime: 'microvm',
    state: 'running',
    image: 'ubuntu-24.04',
    cpus: 2,
    memoryMiB: 4096,
    diskGiB: 20,
    connectors: [],
    llmTokenHash: null,
    ...overrides,
  });

  /** Select chain that resolves to `rows` however far it is followed. */
  const selectQ = (rows: any[]) => {
    const p = Promise.resolve(rows);
    const where: any = () => Object.assign(p.then((r) => r), { limit: () => p });
    return { from: () => ({ where, innerJoin: () => ({ where }) }) };
  };
  const queueSelects = (...results: any[][]) => results.forEach((rows) => db.select.mockReturnValueOnce(selectQ(rows)));
  const updateQ = (rows: any[]) => ({
    set: (values: Record<string, unknown>) => {
      updated.push(values);
      return { where: () => Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) }) };
    },
  });

  async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected rejection');
  }

  const start = (overrides: Record<string, unknown> = {}) =>
    service.startImport('u1', { workspaceId: wsId, image: 'ubuntu-24.04', cpus: 2, memoryMiB: 4096, diskGiB: 20, sizeBytes: 40 * MIB, sha256: SHA, ...overrides });

  beforeEach(() => {
    inserted = [];
    updated = [];
    db = {
      select: vi.fn(),
      insert: vi.fn().mockImplementation(() => ({
        values: (value: Record<string, unknown>) => {
          inserted.push(value);
          return { returning: () => Promise.resolve([{ ...importRow(), ...exportRow(), ...value, id: importId }]) };
        },
      })),
      update: vi.fn().mockImplementation(() => updateQ([{ id: importId }])),
      delete: vi.fn().mockReturnValue({ where: () => Promise.resolve([]) }),
    };
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'member' }) };
    workspaces = { getById: vi.fn().mockResolvedValue({ id: wsId, organizationId: orgId }) };
    docks = {
      create: vi.fn().mockResolvedValue({ id: dockId, state: 'provisioning' }),
      loadReadableDock: vi.fn().mockResolvedValue({ dock: dockRow(), orgId }),
      reapply: vi.fn().mockResolvedValue(undefined),
    };
    envs = { assertSecretsLaunchable: vi.fn().mockResolvedValue(undefined), egressAllowFor: vi.fn().mockResolvedValue(null) };
    objects = {
      directTransfers: true,
      startUpload: vi.fn().mockResolvedValue('up-1'),
      presignPart: vi.fn().mockImplementation(async (_g: string, _n: string, _u: string, part: number) => `https://store/part-${part}`),
      uploadPart: vi.fn().mockResolvedValue('etag-1'),
      completeUpload: vi.fn().mockResolvedValue(undefined),
      objectSize: vi.fn().mockResolvedValue(5 * MIB),
      putSmallObject: vi.fn().mockResolvedValue(undefined),
      abortUpload: vi.fn().mockResolvedValue(undefined),
      deleteGeneration: vi.fn().mockResolvedValue({ deleted: 1 }),
      presignObject: vi.fn().mockResolvedValue({ mode: 'direct', url: 'https://store/get', expiresInSeconds: 900 }),
      getObject: vi.fn(),
      getObjectRange: vi.fn(),
    };
    hosts = { listOnline: vi.fn().mockResolvedValue([{ id: 'h1', runtime: 'microvm', features: ['verified-imports'] }]) };
    retention = { policyOn: vi.fn().mockResolvedValue(false) };
    config = { get: vi.fn().mockReturnValue('fake') };
    provider = new FakeComputeProvider();
    service = new DockTransfersService(db, orgs, workspaces, docks, envs, objects, hosts, retention, config, provider as never);
  });

  describe('starting an import', () => {
    it('returns presigned part URLs in direct mode and records the upload', async () => {
      queueSelects([{ open: 0 }]);
      const result = await start();
      expect(result).toEqual({
        importId,
        upload: { mode: 'direct', partSize: 16 * MIB, parts: [{ number: 1, url: 'https://store/part-1' }, { number: 2, url: 'https://store/part-2' }, { number: 3, url: 'https://store/part-3' }] },
      });
      expect(inserted[0]).toMatchObject({ organizationId: orgId, workspaceId: wsId, createdBy: 'u1', sizeBytes: 40 * MIB, sha256: SHA, mode: 'direct', partCount: 3, uploadId: 'up-1' });
      expect((inserted[0].expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
      // Part URLs outlive the 15 minute default so a long upload keeps its later parts.
      expect(objects.presignPart).toHaveBeenCalledWith(expect.any(String), 'rootfs.ext4.zst', 'up-1', 1, 86400);
    });

    it('hands out control-plane part paths when the store has no reachable address', async () => {
      objects.directTransfers = false;
      queueSelects([{ open: 0 }]);
      const result = await start();
      expect(result.upload.mode).toBe('proxy');
      expect(result.upload.parts[0]).toEqual({ number: 1, url: `/v1/docks/import/${importId}/parts/1` });
      expect(objects.presignPart).not.toHaveBeenCalled();
    });

    it('refuses a disk bigger than diskGiB with import_too_large before opening an upload', async () => {
      const err = await catchErr(start({ diskGiB: 1, sizeBytes: GIB + 1 }));
      expect(err).toMatchObject({ status: 413, body: { code: 'import_too_large' } });
      expect(objects.startUpload).not.toHaveBeenCalled();
    });

    it('accepts a file of exactly the disk size', async () => {
      queueSelects([{ open: 0 }]);
      await expect(start({ diskGiB: 1, sizeBytes: GIB })).resolves.toMatchObject({ importId });
    });

    it('refuses a proxy upload whose parts would pass the memory cap', async () => {
      objects.directTransfers = false;
      queueSelects([{ open: 0 }]);
      const err = await catchErr(start({ diskGiB: 2048, sizeBytes: 2048 * GIB }));
      expect(err.body.code).toBe('import_too_large');
    });

    it.each([
      [{ image: 'windows-11' }, 'image_unknown'],
      [{ sha256: 'ABC' }, 'validation_error'],
      [{ sha256: 'A'.repeat(64) }, 'validation_error'],
      [{ sizeBytes: 0 }, 'validation_error'],
      [{ cpus: 0 }, 'validation_error'],
      [{ memoryMiB: 100 }, 'validation_error'],
      [{ diskGiB: 0 }, 'validation_error'],
    ])('rejects %j with %s', async (overrides, code) => {
      const err = await catchErr(start(overrides));
      expect(err).toMatchObject({ status: 400, body: { code } });
      expect(objects.startUpload).not.toHaveBeenCalled();
    });

    it('hides a workspace the caller is not a member of as dock_not_found', async () => {
      workspaces.getById.mockRejectedValueOnce(new WorkspaceNotFoundException());
      const err = await catchErr(start());
      expect(err).toMatchObject({ status: 404, body: { code: 'dock_not_found' } });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses a member the default environment secrets before any upload is opened', async () => {
      envs.assertSecretsLaunchable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
      const err = await catchErr(start());
      expect(err).toMatchObject({ status: 403, body: { code: 'environment_secrets_admin_only' } });
      expect(envs.assertSecretsLaunchable).toHaveBeenCalledWith('u1', orgId, undefined);
      expect(objects.startUpload).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('answers runtime_unsupported when no online host runs microVMs', async () => {
      config.get.mockReturnValue('restate');
      hosts.listOnline.mockResolvedValueOnce([{ id: 'g1', runtime: 'gvisor' }]);
      const err = await catchErr(start());
      expect(err).toMatchObject({ status: 409, body: { code: 'runtime_unsupported' } });
      expect(objects.startUpload).not.toHaveBeenCalled();
    });

    it('answers runtime_unsupported until a microVM host registers verified-imports', async () => {
      config.get.mockReturnValue('restate');
      hosts.listOnline.mockResolvedValueOnce([{ id: 'm1', runtime: 'microvm', features: ['egress-on-resume'] }, { id: 'g1', runtime: 'gvisor', features: ['verified-imports'] }]);
      expect(await catchErr(start())).toMatchObject({ status: 409, body: { code: 'runtime_unsupported' } });
      expect(objects.startUpload).not.toHaveBeenCalled();
      hosts.listOnline.mockResolvedValueOnce([{ id: 'm1', runtime: 'microvm', features: ['verified-imports'] }]);
      queueSelects([{ open: 0 }]);
      await expect(start()).resolves.toMatchObject({ upload: { mode: 'direct' } });
    });

    it('answers import_egress_unsupported before any upload when the default environment has an allowlist no verifying host can apply', async () => {
      config.get.mockReturnValue('restate');
      envs.egressAllowFor.mockResolvedValue(['api.github.com']);
      hosts.listOnline.mockResolvedValueOnce([{ id: 'm1', runtime: 'microvm', features: ['verified-imports'] }, { id: 'm2', runtime: 'microvm', features: ['egress-on-resume'] }]);
      expect(await catchErr(start())).toMatchObject({ status: 409, body: { code: 'import_egress_unsupported' } });
      expect(envs.egressAllowFor).toHaveBeenCalledWith(orgId, undefined);
      expect(objects.startUpload).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      hosts.listOnline.mockResolvedValueOnce([{ id: 'm1', runtime: 'microvm', features: ['verified-imports', 'egress-on-resume'] }]);
      queueSelects([{ open: 0 }]);
      await expect(start()).resolves.toMatchObject({ upload: { mode: 'direct' } });
    });

    it('does not ask for egress-on-resume when the default environment is open', async () => {
      config.get.mockReturnValue('restate');
      hosts.listOnline.mockResolvedValueOnce([{ id: 'm1', runtime: 'microvm', features: ['verified-imports'] }]);
      queueSelects([{ open: 0 }]);
      await expect(start()).resolves.toMatchObject({ upload: { mode: 'direct' } });
    });

    it('refuses a name already used in the workspace before any upload', async () => {
      queueSelects([{ id: 'existing' }]);
      const err = await catchErr(start({ name: 'taken' }));
      expect(err).toMatchObject({ status: 409, body: { code: 'dock_name_taken' } });
      expect(objects.startUpload).not.toHaveBeenCalled();
    });

    it('caps the open imports of an organization', async () => {
      queueSelects([{ open: 5 }]);
      const err = await catchErr(start());
      expect(err).toMatchObject({ status: 429, body: { code: 'import_limit_reached' } });
      expect(objects.startUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload when the row cannot be saved', async () => {
      queueSelects([{ open: 0 }]);
      db.insert.mockReturnValueOnce({ values: () => ({ returning: () => Promise.reject(new Error('db down')) }) });
      await expect(start()).rejects.toThrow('db down');
      expect(objects.abortUpload).toHaveBeenCalledWith(expect.any(String), 'rootfs.ext4.zst', 'up-1');
    });
  });

  describe('part sizing', () => {
    it('uses 16 MiB parts until the S3 part cap forces larger ones', () => {
      expect(partSizeFor(1)).toBe(16 * MIB);
      expect(partSizeFor(100 * GIB)).toBe(16 * MIB);
      expect(partSizeFor(2048 * GIB)).toBe(210 * MIB);
      expect(Math.ceil((2048 * GIB) / partSizeFor(2048 * GIB))).toBeLessThanOrEqual(10000);
    });
  });

  describe('uploading a part through the proxy', () => {
    const body = (...chunks: string[]) => (async function* () { for (const c of chunks) yield Buffer.from(c); })();

    it('stores the part and returns its etag', async () => {
      queueSelects([importRow({ mode: 'proxy' })]);
      const result = await service.putPart('u1', importId, 1, body('he', 'llo'), 5);
      expect(result).toEqual({ number: 1, etag: 'etag-1' });
      expect(objects.uploadPart).toHaveBeenCalledWith('gen-1', 'rootfs.ext4.zst', 'up-1', 1, Buffer.from('hello'));
    });

    describe('memory bound', () => {
      // A body that parks until released, so parts stay in flight.
      const parked = () => {
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const iterable = (async function* () { await gate; yield Buffer.from('x'); })();
        return { iterable, open };
      };

      it('answers a retryable 429 once an organization has its cap of parts in flight, and frees the slot afterwards', async () => {
        const held = Array.from({ length: MAX_PROXY_PARTS_PER_ORG }, () => parked());
        queueSelects(...held.map(() => [importRow({ mode: 'proxy', partSize: 4 * MIB })]), [importRow({ mode: 'proxy', partSize: 4 * MIB })], [importRow({ mode: 'proxy', partSize: 4 * MIB })]);
        const inFlight = held.map((h) => service.putPart('u1', importId, 1, h.iterable, 1));
        await new Promise((r) => setTimeout(r, 10));
        const err = await catchErr(service.putPart('u1', importId, 1, body('y'), 1));
        expect(err).toMatchObject({ status: 429, body: { code: 'part_upload_busy' } });
        expect(objects.uploadPart).not.toHaveBeenCalled();
        held.forEach((h) => h.open());
        await Promise.all(inFlight);
        await expect(service.putPart('u1', importId, 1, body('y'), 1)).resolves.toMatchObject({ number: 1 });
      });

      it('caps the total reserved part size across organizations and releases it when a part fails', async () => {
        const huge = 128 * MIB;
        const fits = MAX_PROXY_BYTES_IN_FLIGHT / huge;
        const orgs2 = Array.from({ length: fits + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
        const held = orgs2.slice(0, fits).map(() => parked());
        queueSelects(...orgs2.map((o) => [importRow({ mode: 'proxy', partSize: huge, organizationId: o })]), [importRow({ mode: 'proxy', partSize: huge, organizationId: orgs2[0] })]);
        const inFlight = held.map((h) => service.putPart('u1', importId, 1, h.iterable, 1));
        await new Promise((r) => setTimeout(r, 10));
        expect(await catchErr(service.putPart('u1', importId, 1, body('y'), 1))).toMatchObject({ status: 429, body: { code: 'part_upload_busy' } });
        held.forEach((h) => h.open());
        await Promise.all(inFlight);
        // A failing part (empty body) must still release its reservation.
        expect((await catchErr(service.putPart('u1', importId, 1, body(), 0))).body.code).toBe('validation_error');
      });
    });

    it('stops a body larger than the part size, declared or streamed', async () => {
      queueSelects([importRow({ mode: 'proxy', partSize: 4 })], [importRow({ mode: 'proxy', partSize: 4 })]);
      expect((await catchErr(service.putPart('u1', importId, 1, body('x'), 9))).body.code).toBe('part_too_large');
      expect((await catchErr(service.putPart('u1', importId, 1, body('ab', 'cde')))).body.code).toBe('part_too_large');
      expect(objects.uploadPart).not.toHaveBeenCalled();
    });

    it('refuses numbers outside 1..partCount, empty bodies and direct imports', async () => {
      queueSelects([importRow({ mode: 'proxy' })], [importRow({ mode: 'proxy' })], [importRow({ mode: 'direct' })]);
      expect((await catchErr(service.putPart('u1', importId, 2, body('x')))).body.code).toBe('validation_error');
      expect((await catchErr(service.putPart('u1', importId, 1, body()))).body.code).toBe('validation_error');
      expect((await catchErr(service.putPart('u1', importId, 1, body('x')))).body.code).toBe('conflict');
    });

    it('treats another member, a lost membership and a bad id as import_not_found', async () => {
      queueSelects([importRow({ createdBy: 'someone-else', mode: 'proxy' })], [importRow({ mode: 'proxy' })]);
      expect((await catchErr(service.putPart('u1', importId, 1, body('x')))).body.code).toBe('import_not_found');
      orgs.requireMembership.mockRejectedValueOnce(new Error('not a member'));
      expect((await catchErr(service.putPart('u1', importId, 1, body('x')))).body.code).toBe('import_not_found');
      expect((await catchErr(service.putPart('u1', 'nope', 1, body('x')))).status).toBe(404);
    });

    it('refuses parts once the import expired or left the uploading state', async () => {
      queueSelects([importRow({ mode: 'proxy', expiresAt: new Date(Date.now() - 1000) })], [importRow({ mode: 'proxy', status: 'completing' })]);
      expect((await catchErr(service.putPart('u1', importId, 1, body('x')))).status).toBe(409);
      expect((await catchErr(service.putPart('u1', importId, 1, body('x')))).status).toBe(409);
    });
  });

  describe('completing an import', () => {
    const parts = [{ number: 1, etag: 'e1' }];

    it('joins the parts, writes a whole-image manifest and boots the dock from that generation', async () => {
      queueSelects([importRow()]);
      const dock = await service.completeImport('u1', importId, parts);
      expect(dock).toMatchObject({ id: dockId });
      expect(objects.completeUpload).toHaveBeenCalledWith('gen-1', 'rootfs.ext4.zst', 'up-1', [{ part: 1, etag: 'e1' }]);
      const [generation, name, data] = objects.putSmallObject.mock.calls[0];
      expect([generation, name]).toEqual(['gen-1', 'manifest.json']);
      const manifest = JSON.parse(data.toString());
      expect(manifest).toMatchObject({ snapshotId: 'gen-1', kind: 'full', parentId: null, image: 'ubuntu-24.04' });
      expect(manifest.files).toEqual([{ path: 'rootfs.ext4.zst', size: 5 * MIB, encoding: 'zstd', sha256: SHA }]);
      expect(docks.create).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ workspaceId: wsId, image: 'ubuntu-24.04', cpus: 2, memoryMiB: 4096, diskGiB: 20, importedGeneration: expect.objectContaining({ storeSnapshotId: 'gen-1', sizeBytes: 5 * MIB }) }),
      );
      expect(updated.at(-1)).toMatchObject({ status: 'completed', dockId });
    });

    it('passes the requested name through to the dock', async () => {
      queueSelects([importRow({ name: 'pushed' })]);
      await service.completeImport('u1', importId, parts);
      expect(docks.create.mock.calls[0][1]).toMatchObject({ name: 'pushed' });
    });

    it('answers a repeat of a completed import with the same dock', async () => {
      queueSelects([importRow({ status: 'completed', dockId })], [dockRow()]);
      await expect(service.completeImport('u1', importId, parts)).resolves.toMatchObject({ id: dockId });
      expect(docks.create).not.toHaveBeenCalled();
      expect(objects.completeUpload).not.toHaveBeenCalled();
    });

    it('rejects part lists that miss, repeat or skip a part, or carry an empty etag', async () => {
      const row = importRow({ partCount: 2 });
      queueSelects([row], [row], [row], [row]);
      for (const bad of [[{ number: 1, etag: 'a' }], [{ number: 1, etag: 'a' }, { number: 1, etag: 'a' }], [{ number: 1, etag: 'a' }, { number: 3, etag: 'a' }], [{ number: 1, etag: 'a' }, { number: 2, etag: ' ' }]]) {
        expect((await catchErr(service.completeImport('u1', importId, bad))).body.code).toBe('validation_error');
      }
      expect(objects.completeUpload).not.toHaveBeenCalled();
    });

    it('refuses a second complete while one is running', async () => {
      queueSelects([importRow()]);
      db.update.mockReturnValueOnce(updateQ([]));
      const err = await catchErr(service.completeImport('u1', importId, parts));
      expect(err).toMatchObject({ status: 409, body: { code: 'conflict' } });
      expect(objects.completeUpload).not.toHaveBeenCalled();
    });

    it('fails with import_checksum_mismatch when the stored size is not the declared one, and drops the upload', async () => {
      queueSelects([importRow()]);
      objects.objectSize.mockResolvedValueOnce(5 * MIB - 1);
      const err = await catchErr(service.completeImport('u1', importId, parts));
      expect(err).toMatchObject({ status: 400, body: { code: 'import_checksum_mismatch' } });
      expect(docks.create).not.toHaveBeenCalled();
      expect(updated.at(-1)).toMatchObject({ status: 'failed', error: 'import_checksum_mismatch' });
      expect(objects.deleteGeneration).toHaveBeenCalledWith('gen-1');
    });

    it('fails with import_too_large when the stored object outgrows the disk', async () => {
      queueSelects([importRow({ diskGiB: 1 })]);
      objects.objectSize.mockResolvedValueOnce(GIB + 1);
      expect((await catchErr(service.completeImport('u1', importId, parts))).body.code).toBe('import_too_large');
    });

    it('keeps the assembled upload when no host can take the dock, so complete can be retried', async () => {
      queueSelects([importRow()], [importRow({ status: 'uploaded' })]);
      const { NoHostCapacityException } = await import('../docks/dock-errors');
      docks.create.mockRejectedValueOnce(new NoHostCapacityException());
      expect((await catchErr(service.completeImport('u1', importId, parts))).body.code).toBe('no_host_capacity');
      expect(updated.at(-1)).toMatchObject({ status: 'uploaded' });
      expect(objects.deleteGeneration).not.toHaveBeenCalled();
      // The retry skips assembly and boots from the stored generation.
      objects.completeUpload.mockClear();
      await service.completeImport('u1', importId, []);
      expect(objects.completeUpload).not.toHaveBeenCalled();
      expect(docks.create).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['capacity_exhausted', 'CapacityExhaustedException'],
      ['dock_name_taken', 'DockNameTakenException'],
      ['host_egress_unsupported', 'HostEgressUnsupportedException'],
    ])('keeps the assembled upload on %s', async (code, cls) => {
      queueSelects([importRow()]);
      const errors: Record<string, new (arg: string) => Error> = (await import('../docks/dock-errors')) as never;
      docks.create.mockRejectedValueOnce(new errors[cls]('n'));
      expect((await catchErr(service.completeImport('u1', importId, parts))).body.code).toBe(code);
      expect(updated.at(-1)).toMatchObject({ status: 'uploaded' });
      expect(objects.deleteGeneration).not.toHaveBeenCalled();
    });

    it('ends the import on an image refusal, which an imported dock only meets in its background boot', async () => {
      queueSelects([importRow()]);
      const { ImageUnavailableException } = await import('../docks/dock-errors');
      docks.create.mockRejectedValueOnce(new ImageUnavailableException('ubuntu-24.04'));
      expect((await catchErr(service.completeImport('u1', importId, parts))).body.code).toBe('image_unavailable');
      expect(updated.at(-1)).toMatchObject({ status: 'failed', error: 'image_unavailable' });
      expect(objects.deleteGeneration).toHaveBeenCalledWith('gen-1');
    });

    it('discards the upload when the dock cannot be created for another reason', async () => {
      queueSelects([importRow()]);
      docks.create.mockRejectedValueOnce(new Error('db down'));
      await expect(service.completeImport('u1', importId, parts)).rejects.toThrow('db down');
      expect(updated.at(-1)).toMatchObject({ status: 'failed' });
      expect(objects.deleteGeneration).toHaveBeenCalledWith('gen-1');
    });

    it('stamps the manifest with the cpu family of the host the boot lands on', async () => {
      // A docklet refuses a generation whose cpuFamily is not its own, and an empty family matches no host.
      queueSelects([importRow()]);
      await service.completeImport('u1', importId, parts);
      expect(JSON.parse(objects.putSmallObject.mock.calls[0][2].toString()).cpuFamily).toBe('');
      const { onPlaced } = docks.create.mock.calls[0][1].importedGeneration;
      await onPlaced({ id: 'h1', cpuFamily: 'GenuineIntel:6:85' });
      const [generation, name, data] = objects.putSmallObject.mock.calls[1];
      expect([generation, name]).toEqual(['gen-1', 'manifest.json']);
      expect(JSON.parse(data.toString())).toMatchObject({ cpuFamily: 'GenuineIntel:6:85', sha256: SHA, sizeBytes: 5 * MIB });
      await onPlaced(null);
      expect(objects.putSmallObject).toHaveBeenCalledTimes(2);
    });

    it('records a host checksum refusal as import_checksum_mismatch when the boot fails later', async () => {
      queueSelects([importRow()]);
      await service.completeImport('u1', importId, parts);
      const { onBootFailed } = docks.create.mock.calls[0][1].importedGeneration;
      await onBootFailed(Object.assign(new Error('bad'), { code: 'checksum_mismatch' }));
      expect(updated.at(-1)).toMatchObject({ status: 'failed', error: 'import_checksum_mismatch' });
    });

    it('refuses a failed or expired import', async () => {
      queueSelects([importRow({ status: 'failed' })], [importRow({ expiresAt: new Date(Date.now() - 1) })]);
      expect((await catchErr(service.completeImport('u1', importId, parts))).status).toBe(409);
      expect((await catchErr(service.completeImport('u1', importId, parts))).status).toBe(409);
    });
  });

  describe('manifest and ranges', () => {
    it('describes the upload as one compressed whole image with its sha256 and size', () => {
      expect(wholeImageManifest({ id: importId, storeSnapshotId: 'g', sizeBytes: 10, sha256: SHA, image: 'ubuntu-24.04' }, 'GenuineIntel:6:85')).toEqual({
        snapshotId: 'g',
        dockId: importId,
        parentId: null,
        kind: 'full',
        cpuFamily: 'GenuineIntel:6:85',
        image: 'ubuntu-24.04',
        source: 'import',
        sha256: SHA,
        sizeBytes: 10,
        files: [{ path: 'rootfs.ext4.zst', size: 10, encoding: 'zstd', sha256: SHA }],
      });
    });

    it('parses one byte range and ignores the rest', () => {
      expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
      expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
      expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
      expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
      expect(parseRange('bytes=-5', 100)).toBeNull();
      expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
      expect(parseRange(undefined, 100)).toBeNull();
    });
  });

  describe('starting an export', () => {
    const live = (rows: any[] = []) => queueSelects(rows);

    it('records a pending export of the dock and returns its id', async () => {
      live();
      vi.spyOn(provider, 'captureDisk').mockReturnValue(new Promise(() => undefined));
      await expect(service.startExport('u1', dockId)).resolves.toEqual({ exportId: importId });
      expect(docks.loadReadableDock).toHaveBeenCalledWith('u1', dockId);
      expect(inserted[0]).toMatchObject({ organizationId: orgId, dockId, createdBy: 'u1', image: 'ubuntu-24.04', cpus: 2, memoryMiB: 4096, diskGiB: 20 });
      expect((inserted[0].expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    });

    it('applies the dock read rules: a member is refused a connector dock it did not create', async () => {
      docks.loadReadableDock.mockRejectedValueOnce(new ConnectorAdminOnlyException());
      const err = await catchErr(service.startExport('u1', dockId));
      expect(err.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('hides a dock of another organization as dock_not_found', async () => {
      docks.loadReadableDock.mockRejectedValueOnce(new DockNotFoundException());
      expect((await catchErr(service.startExport('u1', dockId))).body.code).toBe('dock_not_found');
    });

    it('refuses a gVisor dock with runtime_unsupported', async () => {
      docks.loadReadableDock.mockResolvedValueOnce({ dock: dockRow({ runtime: 'gvisor' }), orgId });
      expect(await catchErr(service.startExport('u1', dockId))).toMatchObject({ status: 409, body: { code: 'runtime_unsupported' } });
    });

    it('refuses a dock that is not running', async () => {
      docks.loadReadableDock.mockResolvedValueOnce({ dock: dockRow({ state: 'archived' }), orgId });
      expect(await catchErr(service.startExport('u1', dockId))).toMatchObject({ status: 409, body: { code: 'dock_not_running' } });
    });

    it('is blocked while zero data retention is on', async () => {
      retention.policyOn.mockResolvedValueOnce(true);
      expect(await catchErr(service.startExport('u1', dockId))).toMatchObject({ status: 403, body: { code: 'zdr_blocks_exports' } });
    });

    it('refuses a second export of a dock while one is pending, and caps live exports', async () => {
      live([{ dockId, state: 'pending' }]);
      expect((await catchErr(service.startExport('u1', dockId))).status).toBe(409);
      live(Array.from({ length: 5 }, (_unused, i) => ({ dockId: `d${i}`, state: 'ready' })));
      expect(await catchErr(service.startExport('u1', dockId))).toMatchObject({ status: 429, body: { code: 'export_limit_reached' } });
    });
  });

  describe('running an export', () => {
    beforeEach(() => db.select.mockImplementation(() => selectQ([])));
    const run = (dock = dockRow()) => service.runExport(exportRow() as never, dock as never, orgId);
    const capture = (overrides: Record<string, unknown> = {}) =>
      vi.spyOn(provider, 'captureDisk').mockResolvedValue({ snapshotId: 'gen-x', sizeBytes: 1234, sha256: SHA, baseImage: 'ubuntu-24.04', ...overrides });

    it('publishes the size, checksum and base of a full capture', async () => {
      capture();
      await run();
      expect(updated.at(-1)).toEqual({ state: 'ready', sizeBytes: 1234, sha256: SHA, baseImage: 'ubuntu-24.04', storeSnapshotId: 'gen-x' });
    });

    /** Queues the credential reads around the capture: the row and dock keys before, then after the re-apply. */
    const tokens = (before: { llm?: string | null; connector?: string | null; keys?: string[] }, after?: { llm?: string | null; connector?: string | null; keys?: string[] }) => {
      const rows = (t: typeof before) => [[{ llm: t.llm ?? null, connector: t.connector ?? null }], (t.keys ?? []).map((id) => ({ id }))];
      queueSelects(...rows(before), ...(after ? rows(after) : []));
    };

    it('re-applies a dock holding connectors after the capture and before publishing', async () => {
      const order: string[] = [];
      capture();
      tokens({ connector: 'c1' }, { connector: 'c2' });
      docks.reapply.mockImplementationOnce(async () => void order.push('reapply'));
      db.update.mockImplementationOnce(() => {
        order.push('publish');
        return updateQ([{ id: exportId }]);
      });
      await run(dockRow({ connectors: ['linear'] }));
      expect(order).toEqual(['reapply', 'publish']);
      expect(docks.reapply).toHaveBeenCalledWith(expect.objectContaining({ id: dockId }), orgId);
    });

    it('re-applies a dock that holds a model gateway token or a dock API key, and leaves a plain dock alone', async () => {
      capture();
      tokens({ llm: 'l1' }, { llm: 'l2' });
      await run();
      tokens({ keys: ['k1'] }, { keys: ['k2'] });
      await run();
      expect(docks.reapply).toHaveBeenCalledTimes(2);
      expect(updated.at(-1)).toMatchObject({ state: 'ready' });
      tokens({});
      await run();
      expect(docks.reapply).toHaveBeenCalledTimes(2);
      expect(updated.at(-1)).toMatchObject({ state: 'ready' });
    });

    it('fails the export and drops the capture when the re-apply throws', async () => {
      capture();
      tokens({ connector: 'c1' });
      docks.reapply.mockRejectedValueOnce(new Error('host down'));
      const drop = vi.spyOn(provider, 'deleteBacking');
      await run(dockRow({ connectors: ['linear'] }));
      expect(updated.at(-1)).toEqual({ state: 'failed', error: 'export_failed' });
      expect(drop).toHaveBeenCalledWith('gen-x');
    });

    it('never publishes a disk whose credentials are still live after the re-apply', async () => {
      // EnvironmentApplyService.apply records a failure instead of throwing, so the hashes are what prove the rotation.
      capture();
      for (const [before, after] of [
        [{ llm: 'l1' }, { llm: 'l1' }],
        [{ connector: 'c1' }, { connector: 'c1' }],
        [{ keys: ['k1'] }, { keys: ['k1'] }],
        [{ llm: 'l1', keys: ['k1'] }, { llm: 'l2', keys: ['k1'] }],
      ]) {
        tokens(before, after);
        await run();
        expect(updated.at(-1)).toEqual({ state: 'failed', error: 'export_failed' });
      }
    });

    it('fails with export_base_unsupported and deletes the capture when the base is not a Dockyard image', async () => {
      capture({ baseImage: '' });
      const drop = vi.spyOn(provider, 'deleteBacking');
      await run();
      expect(updated.at(-1)).toEqual({ state: 'failed', error: 'export_base_unsupported' });
      expect(drop).toHaveBeenCalledWith('gen-x');
    });

    it('still rotates tokens when the base check fails, since the capture already holds them', async () => {
      capture({ baseImage: '' });
      tokens({ connector: 'c1' }, { connector: 'c2' });
      await run(dockRow({ connectors: ['linear'] }));
      expect(docks.reapply).toHaveBeenCalledTimes(1);
    });

    it('fails an export whose host sent no usable checksum', async () => {
      capture({ sha256: '' });
      await run();
      expect(updated.at(-1)).toEqual({ state: 'failed', error: 'export_failed' });
    });

    it('fails the export when the capture throws', async () => {
      provider.failNextCapture();
      await run();
      expect(updated.at(-1)).toEqual({ state: 'failed', error: 'export_failed' });
    });

    it('drops the object when the export was swept while it ran', async () => {
      capture();
      db.update.mockReturnValueOnce(updateQ([]));
      const drop = vi.spyOn(provider, 'deleteBacking');
      await run();
      expect(drop).toHaveBeenCalledWith('gen-x');
    });
  });

  describe('reading an export', () => {
    const ready = (overrides: Record<string, unknown> = {}) =>
      exportRow({ state: 'ready', sizeBytes: 1234, sha256: SHA, baseImage: 'ubuntu-24.04', storeSnapshotId: 'gen-x', ...overrides });

    it('answers a fresh presigned URL on every call', async () => {
      queueSelects([ready()], [{ id: dockId }], [ready()], [{ id: dockId }]);
      objects.presignObject.mockResolvedValueOnce({ mode: 'direct', url: 'https://store/get-1', expiresInSeconds: 900 }).mockResolvedValueOnce({ mode: 'direct', url: 'https://store/get-2', expiresInSeconds: 900 });
      const first = await service.getExport('u1', exportId);
      const second = await service.getExport('u1', exportId);
      expect([first.url, second.url]).toEqual(['https://store/get-1', 'https://store/get-2']);
      expect(first).toMatchObject({ state: 'ready', image: 'ubuntu-24.04', cpus: 2, memoryMiB: 4096, diskGiB: 20, sizeBytes: 1234, sha256: SHA, baseImage: 'ubuntu-24.04' });
      expect(objects.presignObject).toHaveBeenCalledWith('gen-x', 'rootfs.ext4.zst', 'get');
      expect(first.urlExpiresAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    });

    it('points at the download route when the store cannot be reached directly', async () => {
      queueSelects([ready()], [{ id: dockId }]);
      objects.presignObject.mockResolvedValueOnce({ mode: 'proxy', url: '', expiresInSeconds: 0 });
      expect((await service.getExport('u1', exportId)).url).toBe(`/v1/docks/exports/${exportId}/download`);
    });

    it('has no url while pending, and reports the failure code of a failed export', async () => {
      queueSelects([exportRow()], [{ id: dockId }], [exportRow({ state: 'failed', error: 'export_base_unsupported' })], [{ id: dockId }]);
      const pending = await service.getExport('u1', exportId);
      expect(pending).toMatchObject({ state: 'pending', url: null, sizeBytes: null, sha256: null, baseImage: null });
      expect(pending).not.toHaveProperty('error');
      expect(await service.getExport('u1', exportId)).toMatchObject({ state: 'failed', error: 'export_base_unsupported', url: null });
      expect(objects.presignObject).not.toHaveBeenCalled();
    });

    it('requires the same access as the source dock', async () => {
      queueSelects([ready()], [{ id: dockId }], [ready()], [{ id: dockId }]);
      docks.loadReadableDock.mockRejectedValueOnce(new DockNotFoundException());
      expect((await catchErr(service.getExport('u1', exportId))).body.code).toBe('export_not_found');
      docks.loadReadableDock.mockRejectedValueOnce(new ConnectorAdminOnlyException());
      expect((await catchErr(service.getExport('u1', exportId))).status).toBe(403);
    });

    it('lets only the exporter or an admin read the export of a deleted dock', async () => {
      queueSelects([ready({ createdBy: 'other' })], [], [ready({ createdBy: 'u1' })], [], [ready({ createdBy: 'other' })], []);
      expect((await catchErr(service.getExport('u1', exportId))).body.code).toBe('export_not_found');
      await expect(service.getExport('u1', exportId)).resolves.toMatchObject({ state: 'ready' });
      orgs.requireMembership.mockResolvedValue({ role: 'admin' });
      await expect(service.getExport('u1', exportId)).resolves.toMatchObject({ state: 'ready' });
    });

    it('hides unknown, expired and malformed exports as export_not_found', async () => {
      queueSelects([], [ready({ expiresAt: new Date(Date.now() - 1) })]);
      expect((await catchErr(service.getExport('u1', exportId))).status).toBe(404);
      expect((await catchErr(service.getExport('u1', exportId))).body.code).toBe('export_not_found');
      expect((await catchErr(service.getExport('u1', 'not-a-uuid'))).status).toBe(404);
    });

    it('streams a byte range of a ready export for a resumed download', async () => {
      queueSelects([ready()], [{ id: dockId }]);
      objects.getObjectRange.mockResolvedValueOnce('stream');
      const handle = await service.openDownload('u1', exportId, 'bytes=100-');
      expect(handle).toMatchObject({ partial: true, start: 100, end: 1233, size: 1234, stream: 'stream' });
      expect(objects.getObjectRange).toHaveBeenCalledWith('gen-x', 'rootfs.ext4.zst', 100, 1134);
    });

    it('answers a range past the end with 416 carrying the size', async () => {
      queueSelects([ready()], [{ id: dockId }]);
      const err = await catchErr(service.openDownload('u1', exportId, 'bytes=1234-'));
      expect(err).toMatchObject({ status: 416, body: { code: 'range_not_satisfiable' } });
      queueSelects([ready()], [{ id: dockId }]);
      await expect(service.openDownload('u1', exportId, 'bytes=5-3')).rejects.toMatchObject({ status: 416, size: 1234 });
      expect(objects.getObjectRange).not.toHaveBeenCalled();
    });

    it('streams the whole object without a range, and refuses a pending export', async () => {
      queueSelects([ready()], [{ id: dockId }], [exportRow()], [{ id: dockId }]);
      objects.getObject.mockResolvedValueOnce({ stream: 'all', size: 1234 });
      expect(await service.openDownload('u1', exportId)).toMatchObject({ partial: false, start: 0, end: 1233, stream: 'all' });
      expect((await catchErr(service.openDownload('u1', exportId))).status).toBe(409);
    });
  });

  describe('expiry sweep', () => {
    it('removes expired exports with their objects and keeps the row when the object cannot be removed', async () => {
      queueSelects([exportRow({ id: 'e1', storeSnapshotId: 'gen-a' }), exportRow({ id: 'e2', storeSnapshotId: 'gen-b' }), exportRow({ id: 'e3' })], []);
      const drop = vi.spyOn(provider, 'deleteBacking').mockImplementation(async (id) => {
        if (id === 'gen-b') throw new Error('store down');
      });
      db.update.mockReturnValueOnce(updateQ([]));
      const result = await service.sweep();
      expect(result).toEqual({ imports: 0, exports: 2, interrupted: 0 });
      expect(drop).toHaveBeenCalledWith('gen-a');
      expect(drop).toHaveBeenCalledTimes(2);
      expect(db.delete).toHaveBeenCalledTimes(2);
    });

    it('aborts abandoned uploads and deletes their generation, but never a completed import\'s', async () => {
      queueSelects([], [importRow({ id: 'i1', status: 'uploading' }), importRow({ id: 'i2', status: 'completed', storeSnapshotId: 'gen-kept', dockId }), importRow({ id: 'i3', status: 'failed', storeSnapshotId: 'gen-3' }), importRow({ id: 'i4', status: 'failed', storeSnapshotId: 'gen-boot-failed', dockId })]);
      db.update.mockReturnValueOnce(updateQ([]));
      const result = await service.sweep();
      expect(result.imports).toBe(4);
      expect(objects.abortUpload).toHaveBeenCalledTimes(2);
      expect(objects.deleteGeneration.mock.calls.map((c: string[]) => c[0]).sort()).toEqual(['gen-1', 'gen-3']);
      expect(objects.deleteGeneration).not.toHaveBeenCalledWith('gen-kept');
      // A dock whose boot failed still holds the generation through its snapshot row.
      expect(objects.deleteGeneration).not.toHaveBeenCalledWith('gen-boot-failed');
    });

    it('marks exports pending past the capture deadline as interrupted', async () => {
      queueSelects([], []);
      db.update.mockReturnValueOnce(updateQ([{ id: 'e1' }, { id: 'e2' }]));
      const result = await service.sweep();
      expect(result.interrupted).toBe(2);
      expect(updated[0]).toEqual({ state: 'failed', error: 'export_interrupted' });
    });
  });

  it('does not let a forbidden error from the dock rules turn into a 404 elsewhere', async () => {
    docks.loadReadableDock.mockRejectedValueOnce(new ForbiddenException({ code: 'secrets_admin_only', message: 'no' }));
    expect((await catchErr(service.startExport('u1', dockId))).body.code).toBe('secrets_admin_only');
  });
});
