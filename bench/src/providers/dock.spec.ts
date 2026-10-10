import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockApiError, DockProvider } from './dock.ts';

interface Req {
  method: string;
  path: string;
  auth?: string;
  confirm?: string;
  body: any;
}

let server: Server;
let url: string;
let requests: Req[];
let handler: (req: Req, res: ServerResponse) => void;

const send = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const data = (res: ServerResponse, d: unknown, status = 200) => send(res, status, { ok: true, data: d });

beforeEach(async () => {
  requests = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const r: Req = {
        method: req.method!,
        path: req.url!,
        auth: req.headers.authorization,
        confirm: req.headers['x-confirm-delete'] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(r);
      handler(r, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const provider = (extra = {}) =>
  new DockProvider({ apiUrl: url, apiKey: 'dock_test', workspaceId: 'ws-1', pollIntervalMs: 5, readyTimeoutMs: 500, ...extra });

describe('DockProvider', () => {
  it('creates, polls to ready, execs and destroys over the v1 API', async () => {
    let polls = 0;
    handler = (req, res) => {
      if (req.method === 'POST' && req.path === '/v1/docks') return data(res, { id: 'd1', state: 'provisioning', runtime: 'microvm' }, 201);
      if (req.path === '/v1/docks/d1' && req.method === 'GET') {
        return data(res, { id: 'd1', state: ++polls < 3 ? 'provisioning' : 'ready', runtime: 'microvm' });
      }
      if (req.path === '/v1/docks/d1/exec') return data(res, { exitCode: 0, stdout: '', stderr: '', durationMs: 3, truncated: false });
      if (req.method === 'DELETE') return data(res, { id: 'op1', status: 'pending' }, 202);
      if (req.path === '/v1/operations/op1') return data(res, { id: 'op1', status: 'completed' });
      if (req.path === '/v1/health') return data(res, { status: 'ok' });
      send(res, 404, { ok: false, code: 'not_found', message: req.path });
    };
    const p = provider();
    const h = await p.create();
    expect(h).toEqual({ id: 'd1' });
    expect(polls).toBe(3);
    expect(await p.exec(h, 'true')).toEqual({ exitCode: 0, stdout: '' });
    await p.destroy(h);

    const create = requests.find((r) => r.method === 'POST' && r.path === '/v1/docks')!;
    expect(create.auth).toBe('Bearer dock_test');
    expect(create.body).toMatchObject({ workspaceId: 'ws-1', cpus: 2, memoryMiB: 4096, diskGiB: 20 });
    expect(requests.find((r) => r.method === 'DELETE')!.confirm).toBe('d1');
    expect(await p.info()).toEqual({ version: undefined, runtime: 'microvm' });
  });

  it('turns the error envelope into a DockApiError with its code', async () => {
    handler = (_req, res) => send(res, 503, { ok: false, code: 'capacity_exhausted', message: 'No room' });
    const err = await provider().create().catch((e) => e);
    expect(err).toBeInstanceOf(DockApiError);
    expect(err).toMatchObject({ code: 'capacity_exhausted', status: 503 });
    expect(err.message).toContain('No room');
  });

  it('rejects a non-JSON response as bad_response', async () => {
    handler = (_req, res) => {
      res.writeHead(502);
      res.end('<html>bad gateway</html>');
    };
    await expect(provider().create()).rejects.toMatchObject({ code: 'bad_response', status: 502 });
  });

  it('destroys a dock that never became ready', async () => {
    handler = (req, res) => {
      if (req.method === 'POST' && req.path === '/v1/docks') return data(res, { id: 'd2', state: 'provisioning' }, 201);
      if (req.path === '/v1/docks/d2' && req.method === 'GET') return data(res, { id: 'd2', state: 'error' });
      if (req.method === 'DELETE') return data(res, { id: 'op2', status: 'pending' }, 202);
      if (req.path === '/v1/operations/op2') return data(res, { id: 'op2', status: 'completed' });
      send(res, 404, { ok: false, code: 'not_found', message: req.path });
    };
    await expect(provider().create()).rejects.toThrow('state error');
    expect(requests.some((r) => r.method === 'DELETE' && r.path === '/v1/docks/d2')).toBe(true);
  });

  it('treats deleting a missing dock as done', async () => {
    handler = (_req, res) => send(res, 404, { ok: false, code: 'dock_not_found', message: 'Dock not found' });
    await expect(provider().destroy({ id: 'gone' })).resolves.toBeUndefined();
  });

  it('discovers the workspace when none is configured', async () => {
    handler = (req, res) => {
      if (req.path === '/v1/organizations') return data(res, [{ id: 'org-1' }]);
      if (req.path === '/v1/organizations/org-1/workspaces') return data(res, [{ id: 'ws-found' }]);
      if (req.path === '/v1/docks') return data(res, { id: 'd3', state: 'ready' }, 201);
      send(res, 404, { ok: false, code: 'not_found', message: req.path });
    };
    await provider({ workspaceId: undefined }).create();
    expect(requests.find((r) => r.path === '/v1/docks')!.body.workspaceId).toBe('ws-found');
  });

  it('stops until archived and resumes until live', async () => {
    let state = 'ready';
    handler = (req, res) => {
      if (req.path === '/v1/docks/d4/stop') {
        state = 'archived';
        return data(res, { id: 'd4', state: 'archiving' }, 202);
      }
      if (req.path === '/v1/docks/d4/resume') {
        state = 'ready';
        return data(res, { id: 'd4', state: 'provisioning' }, 202);
      }
      if (req.path === '/v1/docks/d4') return data(res, { id: 'd4', state });
      send(res, 404, { ok: false, code: 'not_found', message: req.path });
    };
    const p = provider();
    await p.stop({ id: 'd4' });
    expect(state).toBe('archived');
    await p.resume({ id: 'd4' });
    expect(state).toBe('ready');
  });

  it('removes already-made copies when a branch fails part way', async () => {
    let n = 0;
    const deleted: string[] = [];
    handler = (req, res) => {
      if (req.path === '/v1/docks/src/branch') {
        const i = ++n;
        if (i === 2) return send(res, 503, { ok: false, code: 'no_host_capacity', message: 'full' });
        return data(res, { id: `c${i}`, state: 'ready' }, 201);
      }
      if (req.method === 'DELETE') {
        deleted.push(req.path);
        return data(res, { id: 'op', status: 'pending' }, 202);
      }
      if (req.path === '/v1/operations/op') return data(res, { id: 'op', status: 'completed' });
      send(res, 404, { ok: false, code: 'not_found', message: req.path });
    };
    await expect(provider().branch({ id: 'src' }, 3)).rejects.toMatchObject({ code: 'no_host_capacity' });
    expect(deleted.sort()).toEqual(['/v1/docks/c1', '/v1/docks/c3']);
  });
});
