import { ForbiddenException, NotFoundException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PassThrough, Readable } from 'stream';
import { vi, type Mock } from 'vitest';
import { EnvelopeInterceptor } from '../common/envelope.interceptor';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { DB } from '../database/database.module';
import { FleetController } from './fleet.controller';
import { FleetObjectsService } from './fleet-objects.service';
import { FleetService } from './fleet.service';
import { FleetObjectAccess } from './fleet-object-access';
import { HostCommandQueue, hashCredential } from './host-command-queue';

const TOKEN = 'hc_host-a-credential';
const SHARED_TOKEN = 'shared-enrollment-token';
const OBJECT = '/v1/fleet/objects/snap-1/rootfs.ext4';

/** Fake select chain returning the one known host row, like the credential lookup does. */
const hostsDb = (row: { id: string; hash: string }) => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
});

/**
 * Drives the object routes over real HTTP: the fleet controller's hardest
 * requirements are transport-level (raw stream in, bare stream out, token
 * first), and only an actual request proves them.
 */
describe('FleetController object routes', () => {
  let app: INestApplication;
  let origin: string;
  let access: { assertRead: Mock; assertWrite: Mock };
  let objects: {
    putPart: Mock;
    getObject: Mock;
    deleteGeneration: Mock;
    listGeneration: Mock;
  };

  const send = (method: string, path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, {
      ...init,
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });

  beforeEach(async () => {
    objects = {
      putPart: vi.fn(async () => ({ complete: true, size: 4 })),
      getObject: vi.fn(async () => ({ stream: Readable.from([Buffer.from('AAAA')]), size: 4 })),
      deleteGeneration: vi.fn(async () => ({ deleted: 2 })),
      listGeneration: vi.fn(async () => ({ files: [{ path: 'rootfs.ext4', size: 4 }] })),
    };
    access = { assertRead: vi.fn(async () => undefined), assertWrite: vi.fn(async () => undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [FleetController],
      providers: [
        { provide: FleetService, useValue: {} },
        { provide: FleetObjectsService, useValue: objects },
        { provide: FleetObjectAccess, useValue: access },
        { provide: ConfigService, useValue: new ConfigService({ FLEET_TOKEN: SHARED_TOKEN }) },
        // Only host-a's credential is known; the lookup resolves its hash row.
        { provide: DB, useValue: hostsDb({ id: 'host-a', hash: hashCredential(TOKEN) }) },
        HostCommandQueue,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts: same prefix, validation and envelope, so the spec fails
    // wherever a host would see a different response.
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0);
    origin = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses every object route without a host credential', async () => {
    const routes: Array<[string, string]> = [
      ['PUT', `${OBJECT}?part=0&parts=1&size=4`],
      ['GET', OBJECT],
      ['GET', '/v1/fleet/objects/snap-1'],
      ['DELETE', '/v1/fleet/objects/snap-1'],
    ];

    for (const [method, path] of routes) {
      const response = await fetch(`${origin}${path}`, { method });
      expect([method, path, response.status]).toEqual([method, path, 401]);
      expect(await response.json()).toEqual({ ok: false, code: 'host_credential_unknown', message: 'Unknown host credential; register again' });
    }
    expect(objects.putPart).not.toHaveBeenCalled();
    expect(objects.listGeneration).not.toHaveBeenCalled();
  });

  it('refuses a wrong token on the streaming download', async () => {
    const response = await fetch(`${origin}${OBJECT}`, { headers: { authorization: 'Bearer nope' } });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: 'host_credential_unknown' });
    expect(objects.getObject).not.toHaveBeenCalled();
  });

  it('refuses the shared enrollment token on the object routes', async () => {
    const response = await fetch(`${origin}${OBJECT}`, { headers: { authorization: `Bearer ${SHARED_TOKEN}` } });

    expect(response.status).toBe(401);
    expect(objects.getObject).not.toHaveBeenCalled();
  });

  it('scopes every object route to the calling host and stops when access is denied', async () => {
    const denied = new ForbiddenException({ code: 'generation_forbidden', message: 'Generation is not available to this host' });
    access.assertRead.mockRejectedValue(denied);
    access.assertWrite.mockRejectedValue(denied);
    const routes: Array<[string, string, RequestInit]> = [
      ['PUT', `${OBJECT}?part=0&parts=1&size=4`, { body: 'AAAA' }],
      ['GET', OBJECT, {}],
      ['GET', '/v1/fleet/objects/snap-1', {}],
      ['DELETE', '/v1/fleet/objects/snap-1', {}],
      ['POST', `${OBJECT}/url`, { body: JSON.stringify({ op: 'get' }), headers: { 'content-type': 'application/json' } }],
      ['POST', `${OBJECT}/url`, { body: JSON.stringify({ op: 'put', size: 4 }), headers: { 'content-type': 'application/json' } }],
    ];

    for (const [method, path, init] of routes) {
      const response = await send(method, path, init);
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(await response.json()).toMatchObject({ ok: false, code: 'generation_forbidden' });
    }
    expect(access.assertRead).toHaveBeenCalledWith('host-a', 'snap-1');
    expect(access.assertWrite).toHaveBeenCalledWith('host-a', 'snap-1');
    for (const fn of [objects.putPart, objects.getObject, objects.listGeneration, objects.deleteGeneration]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed part coordinates before touching the store', async () => {
    for (const query of ['part=abc&parts=1&size=4', 'part=0&parts=0&size=4', 'part=0&parts=1&size=-1', 'part=0&parts=1']) {
      const response = await send('PUT', `${OBJECT}?${query}`, { body: 'AAAA' });

      expect([query, response.status]).toEqual([query, 400]);
      expect(await response.json()).toMatchObject({ ok: false, code: 'validation_error' });
    }
    expect(objects.putPart).not.toHaveBeenCalled();
  });

  it('streams the raw upload body to the store untouched', async () => {
    const received: Buffer[] = [];
    objects.putPart.mockImplementation(
      async (
        _snapshotId: string,
        _name: string,
        _part: number,
        _parts: number,
        _size: number,
        body: Readable,
      ) => {
        // Mirrors the real service: the store drains the request stream.
        for await (const chunk of body) received.push(Buffer.from(chunk as Buffer));
        return { complete: true, size: 4 };
      },
    );

    const response = await send('PUT', `${OBJECT}?part=1&parts=3&size=8`, {
      headers: { 'content-type': 'application/octet-stream' },
      body: 'BBBB',
    });

    expect(await response.json()).toEqual({ ok: true, data: { complete: true, size: 4 } });
    const [snapshotId, name, part, parts, size] = objects.putPart.mock.calls[0] as [
      string,
      string,
      number,
      number,
      number,
    ];
    expect([snapshotId, name, part, parts, size]).toEqual(['snap-1', 'rootfs.ext4', 1, 3, 8]);
    // The JSON body parser must not have consumed the octet-stream body.
    expect(Buffer.concat(received).toString()).toBe('BBBB');
  });

  it('returns the composed object as bare bytes, not the JSON envelope', async () => {
    const response = await send('GET', OBJECT);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('AAAA');
    expect(objects.getObject).toHaveBeenCalledWith('snap-1', 'rootfs.ext4');
  });

  it('answers a missing object with 404 object_not_found', async () => {
    objects.getObject.mockRejectedValue(
      new NotFoundException({ code: 'object_not_found', message: 'no such object: rootfs.ext4' }),
    );

    const response = await send('GET', OBJECT);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: 'object_not_found' });
  });

  it('stops reading the store when the host abandons the download', async () => {
    // Headers flush on the first chunk, so the client is up before it aborts.
    const stream = new PassThrough();
    stream.write(Buffer.alloc(4));
    const closed = new Promise<void>((resolve) => stream.on('close', () => resolve()));
    objects.getObject.mockResolvedValue({ stream, size: 1_048_576 });
    const controller = new AbortController();

    const response = await fetch(`${origin}${OBJECT}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
    await closed;

    // The store stream must not keep pulling the rest of a file nobody wants.
    expect(stream.destroyed).toBe(true);
  });

  it('reports how many objects a generation delete removed', async () => {
    const response = await send('DELETE', '/v1/fleet/objects/snap-1');

    expect(await response.json()).toEqual({ ok: true, data: { deleted: 2 } });
    expect(objects.deleteGeneration).toHaveBeenCalledWith('snap-1');
  });

  it('lists a generation inside the usual JSON envelope', async () => {
    const response = await send('GET', '/v1/fleet/objects/snap-1');

    expect(await response.json()).toEqual({ ok: true, data: { files: [{ path: 'rootfs.ext4', size: 4 }] } });
    expect(objects.listGeneration).toHaveBeenCalledWith('snap-1');
  });
});
