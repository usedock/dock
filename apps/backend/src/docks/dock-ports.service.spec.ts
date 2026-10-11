import { EnvironmentSecretsAdminOnlyException } from '../environments/environments.service';
import { createServer, request as httpRequest, type Server } from 'http';
import { connect, type AddressInfo } from 'net';
import { vi } from 'vitest';
import { WebSocket } from 'ws';
import { CommandFailedException } from '../fleet/host-command-queue';
import { DockPortsService, hostHeader, MAX_PORTS_PER_DOCK, forUpstream } from './dock-ports.service';
import { EDGE_PROOF_HEADER, edgeProof } from './port-access-token';
import { PortAuthCache } from './port-auth-cache';
import { DockTunnelService } from './dock-tunnel.service';

const dockId = '33333333-3333-4333-8333-333333333333';
const label = '3000-abcdefghijkmnpqr';

/** Drizzle stand-in: every awaited query chain yields the next queued result. */
function fakeDb(results: unknown[][]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = (): any =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(results.shift() ?? []).then(resolve, reject);
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args });
            return chain();
          };
        },
      },
    );
  return { db: chain(), calls };
}

function portRow(overrides: Record<string, unknown> = {}) {
  return { id: 'p1', dockId, port: 3000, label, visibility: 'public', createdAt: new Date('2026-10-01T00:00:00Z'), ...overrides };
}

function reader(values: Record<string, unknown>) {
  return { get: vi.fn((key: string) => values[key]) };
}

const enabled = { BETTER_AUTH_SECRET: 'test-secret', PORTS_DOMAIN: 'ports.x.dev', PORTS_PROXY_PORT: 0, PUBLIC_API_URL: 'https://api.x.dev', PUBLIC_APP_URL: 'https://app.x.dev', RUNTIME_DRIVER: 'restate' };

describe('hostHeader', () => {
  it('reads exactly one Host header', () => {
    expect(hostHeader('GET / HTTP/1.1\r\nHost: a.x.dev\r\nAccept: */*')).toBe('a.x.dev');
    expect(hostHeader('GET / HTTP/1.1\r\nhost:  a.x.dev  ')).toBe('a.x.dev');
    expect(hostHeader('GET / HTTP/1.1\r\nAccept: */*')).toBeNull();
    expect(hostHeader('GET / HTTP/1.1\r\nHost: a.x.dev\r\nHost: b.x.dev')).toBeNull();
  });
});

describe('DockPortsService', () => {
  let docks: any;
  let tunnels: any;

  beforeEach(() => {
    docks = { loadReadableDock: vi.fn().mockResolvedValue({ dock: { id: dockId }, orgId: 'o1' }) };
    tunnels = { open: vi.fn(), bridge: vi.fn() };
  });

  function service(results: unknown[][], env: Record<string, unknown> = enabled) {
    const { db, calls } = fakeDb(results);
    return { ports: new DockPortsService(db, docks, tunnels, reader(env) as never, new PortAuthCache()), calls };
  }

  it('lists exposed ports with their URLs after a membership check', async () => {
    const { ports } = service([[portRow()]]);
    await expect(ports.list('u1', dockId)).resolves.toEqual([
      { port: 3000, visibility: 'public', url: `https://${label}.ports.x.dev`, createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    expect(docks.loadReadableDock).toHaveBeenCalledWith('u1', dockId);
  });

  it('refuses list, expose and remove on a dock holding admins-only secrets', async () => {
    const { ports } = service([]);
    for (const call of [() => ports.list('u1', dockId), () => ports.expose('u1', dockId, 3000), () => ports.remove('u1', dockId, 3000)]) {
      docks.loadReadableDock.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
      await expect(call()).rejects.toMatchObject({ response: { code: 'environment_secrets_admin_only' } });
    }
  });

  it('keeps the public URL scheme and port in port URLs', async () => {
    const local = { ...enabled, PORTS_DOMAIN: 'ports.localhost', PUBLIC_API_URL: 'http://localhost:8088', PUBLIC_APP_URL: 'http://localhost:8088' };
    const { ports } = service([[portRow()]], local);
    expect((await ports.list('u1', dockId))[0].url).toBe(`http://${label}.ports.localhost:8088`);
  });

  it('reports no URL while hosted ports are off', async () => {
    const { ports } = service([[portRow()]], { PUBLIC_API_URL: 'https://api.x.dev', PUBLIC_APP_URL: 'https://app.x.dev' });
    expect((await ports.list('u1', dockId))[0].url).toBeNull();
  });

  it('exposes a port under a random label', async () => {
    const { ports, calls } = service([[], [{ total: 0 }], [portRow({ label: '8080-k7x2m9q4w8r3t5yz', port: 8080 })]]);
    const view = await ports.expose('u1', dockId, 8080);
    expect(view.url).toBe('https://8080-k7x2m9q4w8r3t5yz.ports.x.dev');
    const values = calls.find((c) => c.method === 'values')!.args[0] as { label: string; port: number };
    expect(values.port).toBe(8080);
    expect(values.label).toMatch(/^8080-[a-z2-9]{16}$/);
    expect(values.visibility).toBe('private');
  });

  it('exposes with an explicit visibility and switches an existing port on request', async () => {
    const created = service([[], [{ total: 0 }], [portRow({ visibility: 'public' })]]);
    await created.ports.expose('u1', dockId, 3000, 'public');
    expect((created.calls.find((c) => c.method === 'values')!.args[0] as { visibility: string }).visibility).toBe('public');

    const switched = service([[portRow({ visibility: 'public' })], [portRow({ visibility: 'private' })]]);
    expect((await switched.ports.expose('u1', dockId, 3000, 'private')).visibility).toBe('private');
    expect(switched.calls.find((c) => c.method === 'set')!.args[0]).toEqual({ visibility: 'private' });

    const kept = service([[portRow({ visibility: 'public' })]]);
    expect((await kept.ports.expose('u1', dockId, 3000)).visibility).toBe('public');
    expect(kept.calls.some((c) => c.method === 'set')).toBe(false);
  });

  it('generates labels with 80 bits of randomness', () => {
    const labels = new Set<string>();
    return Promise.all(
      Array.from({ length: 50 }, async () => {
        const { ports, calls } = service([[], [{ total: 0 }], [portRow()]]);
        await ports.expose('u1', dockId, 3000);
        labels.add((calls.find((c) => c.method === 'values')!.args[0] as { label: string }).label);
      }),
    ).then(() => expect(labels.size).toBe(50));
  });

  it('returns the existing URL when a port is exposed twice', async () => {
    const { ports, calls } = service([[portRow()]]);
    expect((await ports.expose('u1', dockId, 3000)).url).toBe(`https://${label}.ports.x.dev`);
    expect(calls.some((c) => c.method === 'values')).toBe(false);
  });

  it('refuses exposure when off, on the agent port, and past the per-dock cap', async () => {
    await expect(service([], {}).ports.expose('u1', dockId, 3000)).rejects.toMatchObject({ response: { code: 'ports_unavailable' } });
    await expect(service([]).ports.expose('u1', dockId, 2222)).rejects.toMatchObject({ response: { code: 'validation_error' } });
    await expect(service([[], [{ total: MAX_PORTS_PER_DOCK }]]).ports.expose('u1', dockId, 3000)).rejects.toMatchObject({
      response: { code: 'port_limit_reached' },
    });
  });

  it('unexposes a port and 404s an unknown one', async () => {
    await expect(service([[{ id: 'p1' }]]).ports.remove('u1', dockId, 3000)).resolves.toEqual({ deleted: true });
    await expect(service([[]]).ports.remove('u1', dockId, 3000)).rejects.toMatchObject({ response: { code: 'port_not_found' } });
  });

  it('allows edge certificates only for exposed port hostnames', async () => {
    expect(await service([[{ id: 'p1' }]]).ports.hostnameExposed(`${label}.ports.x.dev`)).toBe(true);
    expect(await service([[]]).ports.hostnameExposed(`${label}.ports.x.dev`)).toBe(false);
    const { ports, calls } = service([[{ id: 'p1' }]]);
    expect(await ports.hostnameExposed('api.x.dev')).toBe(false);
    expect(await ports.hostnameExposed(`a.b.ports.x.dev`)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  describe('proxy', () => {
    let ports: DockPortsService;
    let proxyPort: number;

    async function start(results: unknown[][]) {
      ports = service(results).ports;
      proxyPort = (await ports.listen('127.0.0.1')) as number;
    }

    afterEach(() => ports?.onModuleDestroy());

    function raw(request: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const client = connect(proxyPort, '127.0.0.1', () => client.write(request));
        let out = '';
        client.on('data', (d) => (out += d));
        client.on('close', () => resolve(out));
        client.on('error', reject);
      });
    }

    const target = { port: 3000, visibility: 'public', dockId, state: 'ready', hostId: 'h1', billingPausedAt: null };

    it('does not listen while hosted ports are off', async () => {
      await expect(service([], {}).ports.listen('127.0.0.1')).resolves.toBeNull();
    });

    it('answers unknown hosts, stopped docks, and closed ports in plain text', async () => {
      await start([[], [{ ...target, state: 'archived' }], [target]]);
      expect(await raw(`GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n\r\n`)).toMatch(/^HTTP\/1.1 404 [\s\S]*No dock port is exposed/);
      expect(await raw(`GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n\r\n`)).toMatch(/^HTTP\/1.1 503 [\s\S]*resume it to reach port 3000/);
      const { TunnelOpenException } = await import('./dock-tunnel.service');
      tunnels.open.mockRejectedValue(new TunnelOpenException('port_closed', 'Nothing is listening on port 3000 inside the dock'));
      expect(await raw(`GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n\r\n`)).toMatch(/^HTTP\/1.1 502 [\s\S]*Nothing is listening on port 3000/);
      expect(tunnels.open).toHaveBeenCalledWith('h1', dockId, 3000);
    });

    it('serves a private port only with the edge proof, and never passes the proof on', async () => {
      const privateTarget = { ...target, visibility: 'private' };
      await start([[privateTarget], [privateTarget], [privateTarget]]);
      const forged = `GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n${EDGE_PROOF_HEADER}: nope\r\n\r\n`;
      expect(await raw(`GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n\r\n`)).toMatch(/^HTTP\/1.1 403 /);
      expect(await raw(forged)).toMatch(/^HTTP\/1.1 403 /);
      const { TunnelOpenException } = await import('./dock-tunnel.service');
      tunnels.open.mockRejectedValue(new TunnelOpenException('port_closed', 'closed'));
      const proof = edgeProof(reader(enabled), label);
      expect(await raw(`GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n${EDGE_PROOF_HEADER}: ${proof}\r\n\r\n`)).toMatch(/^HTTP\/1.1 502 /);
    });

    it('refuses a stale, future-dated, or malformed proof', async () => {
      const privateTarget = { ...target, visibility: 'private' };
      await start([[privateTarget], [privateTarget], [privateTarget], [privateTarget]]);
      const withProof = (value: string) => raw(`GET / HTTP/1.1\r\nHost: ${label}.ports.x.dev\r\n${EDGE_PROOF_HEADER}: ${value}\r\n\r\n`);
      expect(await withProof(edgeProof(reader(enabled), label, Date.now() - 61_000))).toMatch(/^HTTP\/1.1 403 /);
      expect(await withProof(edgeProof(reader(enabled), label, Date.now() + 120_000))).toMatch(/^HTTP\/1.1 403 /);
      expect(await withProof(edgeProof(reader(enabled), label).replace(/^v1/, 'v0'))).toMatch(/^HTTP\/1.1 403 /);
      expect(await withProof(edgeProof(reader(enabled), '8080-zzzzzzzzzzzzzzzz'))).toMatch(/^HTTP\/1.1 403 /);
    });

    it('removes only the proof header from the buffered request', () => {
      const request = Buffer.from('POST /x HTTP/1.1\r\nHost: a\r\nX-Dock-Port-Auth: abc\r\nX-Other: 1\r\n\r\nbody');
      expect(forUpstream(request, false).toString()).toBe('POST /x HTTP/1.1\r\nHost: a\r\nX-Other: 1\r\n\r\nbody');
      const plain = 'GET / HTTP/1.1\r\nHost: a\r\n\r\n';
      expect(forUpstream(Buffer.from(plain), true).toString()).toBe(plain);
    });

    it('keeps port credentials away from the dock but leaves the app its own cookies and auth', () => {
      const request = (auth: string) => Buffer.from(`GET / HTTP/1.1\r\nHost: a\r\nCookie: app=1; dock_port_access=tok; theme=dark\r\nAuthorization: ${auth}\r\n\r\n`);
      expect(forUpstream(request('Bearer dock_secret'), true).toString()).toBe('GET / HTTP/1.1\r\nHost: a\r\nCookie: app=1; theme=dark\r\n\r\n');
      expect(forUpstream(request('Basic dXNlcjpwYXNz'), true).toString()).toContain('Authorization: Basic dXNlcjpwYXNz\r\n');
      expect(forUpstream(request('Bearer app-token'), true).toString()).toContain('Authorization: Bearer app-token\r\n');
      // A public port's app may take dock keys itself; the port cookie never belongs to it.
      expect(forUpstream(request('Bearer dock_secret'), false).toString()).toContain('Authorization: Bearer dock_secret\r\n');
      const only = Buffer.from('GET / HTTP/1.1\r\nHost: a\r\ncookie: dock_port_access=tok\r\n\r\n');
      expect(forUpstream(only, true).toString()).toBe('GET / HTTP/1.1\r\nHost: a\r\n\r\n');
    });

    it('refuses requests without a Host header or with oversized headers', async () => {
      await start([]);
      expect(await raw('GET / HTTP/1.1\r\nAccept: */*\r\n\r\n')).toMatch(/^HTTP\/1.1 400 /);
      expect(await raw(`GET / HTTP/1.1\r\nX-Big: ${'a'.repeat(70_000)}`)).toMatch(/^HTTP\/1.1 431 /);
    });
  });

  describe('end to end', () => {
    let guest: Server;
    let api: Server;
    let ports: DockPortsService;
    let realTunnels: DockTunnelService;

    afterEach(async () => {
      ports.onModuleDestroy();
      realTunnels.onModuleDestroy();
      guest.closeAllConnections();
      await new Promise((resolve) => guest.close(resolve));
      api.closeAllConnections();
      await new Promise((resolve) => api.close(resolve));
    });

    it('serves a request through the host tunnel to the guest port', async () => {
      guest = createServer((req, res) => res.end(`guest saw ${req.method} ${req.url} for ${req.headers.host}`));
      await new Promise<void>((resolve) => guest.listen(0, '127.0.0.1', resolve));
      api = createServer();
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      const apiUrl = `ws://127.0.0.1:${(api.address() as AddressInfo).port}`;
      // The fake host dials the relay and splices it onto the guest port.
      const queue = {
        authenticateHost: vi.fn(async () => 'h1'),
        execute: vi.fn(async (hostId: string, _op: string, payload: { sessionId: string; secret: string; port: number }) => {
          if (payload.port !== 3000) throw new CommandFailedException('port_closed', 'nothing');
          const relay = new WebSocket(`${apiUrl}/v1/fleet/tunnels/${payload.sessionId}`, {
            headers: { authorization: 'Bearer t', 'x-tunnel-secret': payload.secret },
          });
          const toGuest = connect((guest.address() as AddressInfo).port, '127.0.0.1');
          relay.on('message', (data: Buffer) => toGuest.write(data));
          await new Promise((resolve) => relay.once('open', resolve));
          toGuest.on('data', (data) => relay.send(data));
          toGuest.on('close', () => relay.close());
          relay.on('close', () => toGuest.destroy());
          return {};
        }),
      };
      realTunnels = new DockTunnelService(queue as never);
      api.on('upgrade', (req, socket, head) => realTunnels.acceptHost(req, socket, head, req.url!.split('/').pop()!));
      const { db } = fakeDb([[{ port: 3000, visibility: 'public', dockId, state: 'running', hostId: 'h1', billingPausedAt: null }]]);
      ports = new DockPortsService(db, docks, realTunnels, reader(enabled) as never, new PortAuthCache());
      const proxyPort = (await ports.listen('127.0.0.1')) as number;

      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: proxyPort, path: '/hello?x=1', headers: { host: `${label}.ports.x.dev`, connection: 'close' } },
          (res) => {
            let out = '';
            res.on('data', (d) => (out += d));
            res.on('end', () => resolve(`${res.statusCode} ${out}`));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe(`200 guest saw GET /hello?x=1 for ${label}.ports.x.dev`);
    });
  });
});
