import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Readable } from 'stream';
import { vi, type Mock } from 'vitest';
import { EnvelopeInterceptor } from '../common/envelope.interceptor';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { RangeNotSatisfiableException } from './dock-transfer-errors';
import { DockTransfersController } from './dock-transfers.controller';
import { DockTransfersService } from './dock-transfers.service';

const SHA = 'a'.repeat(64);
const WS = '22222222-2222-4222-8222-222222222222';

describe('DockTransfersController', () => {
  let app: INestApplication;
  let origin: string;
  let service: Record<string, Mock>;
  let received = '';

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/v1${path}`, {
      method,
      headers: body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? (body as unknown as BodyInit) : JSON.stringify(body),
    });

  beforeEach(async () => {
    service = {
      startImport: vi.fn().mockResolvedValue({ importId: 'i1', upload: { mode: 'proxy', partSize: 16, parts: [] } }),
      putPart: vi.fn().mockImplementation(async (_user: unknown, _id: string, _n: number, body: AsyncIterable<Buffer>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk);
        received = Buffer.concat(chunks).toString();
        return { number: 2, etag: 'etag-2' };
      }),
      completeImport: vi.fn().mockResolvedValue({ id: 'd1', name: 'pushed', state: 'provisioning', workspaceId: WS, runtime: 'microvm', connectors: [] }),
      startExport: vi.fn().mockResolvedValue({ exportId: 'e1' }),
      getExport: vi.fn().mockResolvedValue({ state: 'pending' }),
      openDownload: vi.fn(),
    };
    const moduleRef = await Test.createTestingModule({ controllers: [DockTransfersController], providers: [{ provide: DockTransfersService, useValue: service }] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'u1' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalInterceptors(new EnvelopeInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0);
    origin = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
  });

  const importBody = { workspaceId: WS, image: 'ubuntu-24.04', cpus: 2, memoryMiB: 4096, diskGiB: 20, sizeBytes: 100, sha256: SHA };

  it('answers an import start with 201 and the upload plan in the envelope', async () => {
    const res = await call('POST', '/docks/import', importBody);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, data: { importId: 'i1', upload: { mode: 'proxy', partSize: 16, parts: [] } } });
  });

  it('validates the import body', async () => {
    for (const bad of [{ ...importBody, sha256: 'xyz' }, { ...importBody, sizeBytes: 0 }, { ...importBody, extra: 1 }, { ...importBody, workspaceId: 'nope' }]) {
      expect((await call('POST', '/docks/import', bad)).status).toBe(400);
    }
    expect(service.startImport).not.toHaveBeenCalled();
  });

  it('returns the part etag both as the ETag header and as data.etag', async () => {
    const res = await call('PUT', '/docks/import/i1/parts/2', Buffer.from('bytes'), { 'content-type': 'application/octet-stream' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('etag-2');
    expect(await res.json()).toEqual({ ok: true, data: { number: 2, etag: 'etag-2' } });
    const [, importId, number, , declared] = service.putPart.mock.calls[0];
    expect([importId, number, declared]).toEqual(['i1', 2, 5]);
    expect(received).toBe('bytes');
  });

  it('rejects a non numeric part number', async () => {
    expect((await call('PUT', '/docks/import/i1/parts/x', Buffer.from('b'))).status).toBe(400);
  });

  it('completes with 202 and the standard dock object', async () => {
    const res = await call('POST', '/docks/import/i1/complete', { parts: [{ number: 1, etag: 'e' }] });
    expect(res.status).toBe(202);
    const { ok, data } = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(ok).toBe(true);
    expect(data).toMatchObject({ id: 'd1', name: 'pushed', state: 'provisioning', workspaceId: WS });
    expect(service.completeImport).toHaveBeenCalledWith(expect.anything(), 'i1', [{ number: 1, etag: 'e' }]);
  });

  it('requires at least one part to complete', async () => {
    expect((await call('POST', '/docks/import/i1/complete', { parts: [] })).status).toBe(400);
  });

  it('starts an export with 202 and reads it back', async () => {
    const started = await call('POST', '/docks/d1/export');
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ ok: true, data: { exportId: 'e1' } });
    const read = await call('GET', '/docks/exports/e1');
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: true, data: { state: 'pending' } });
  });

  it('passes the requested export formats to the service and defaults to none', async () => {
    await call('POST', '/docks/d1/export', { formats: ['work-tar'] });
    expect(service.startExport).toHaveBeenLastCalledWith(expect.anything(), 'd1', ['work-tar']);
    await call('POST', '/docks/d1/export');
    expect(service.startExport).toHaveBeenLastCalledWith(expect.anything(), 'd1', undefined);
    // CLIs up to v0.3.4 send an empty object.
    await call('POST', '/docks/d1/export', {});
    expect(service.startExport).toHaveBeenLastCalledWith(expect.anything(), 'd1', undefined);
  });

  it('validates the export body', async () => {
    service.startExport.mockClear();
    for (const bad of [{ formats: ['zip'] }, { formats: [] }, { formats: 'disk' }, { formats: ['disk', 'disk'] }, { extra: 1 }]) {
      expect((await call('POST', '/docks/d1/export', bad)).status).toBe(400);
    }
    expect(service.startExport).not.toHaveBeenCalled();
  });

  it('streams a download, and a range with 206 and Content-Range', async () => {
    service.openDownload.mockResolvedValueOnce({ stream: Readable.from([Buffer.from('0123456789')]), size: 10, start: 0, end: 9, partial: false });
    const whole = await call('GET', '/docks/exports/e1/download');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await whole.arrayBuffer()).toString()).toBe('0123456789');
    service.openDownload.mockResolvedValueOnce({ stream: Readable.from([Buffer.from('56789')]), size: 10, start: 5, end: 9, partial: true });
    const part = await call('GET', '/docks/exports/e1/download', undefined, { range: 'bytes=5-' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 5-9/10');
    expect(service.openDownload).toHaveBeenLastCalledWith(expect.anything(), 'e1', 'bytes=5-');
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('56789');
  });

  it('answers an unsatisfiable range with 416 and Content-Range: bytes */size', async () => {
    service.openDownload.mockRejectedValueOnce(new RangeNotSatisfiableException(10));
    const res = await call('GET', '/docks/exports/e1/download', undefined, { range: 'bytes=10-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
    expect(await res.json()).toMatchObject({ ok: false, code: 'range_not_satisfiable' });
  });
});
