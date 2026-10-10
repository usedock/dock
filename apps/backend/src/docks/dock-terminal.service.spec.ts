import { HttpException, UnauthorizedException } from '@nestjs/common';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { vi } from 'vitest';
import { WebSocket } from 'ws';
import { CommandFailedException } from '../fleet/host-command-queue';
import { ExecUnavailableException } from './dock-errors';
import { DockTerminalService, MAX_TERMINALS_PER_DOCK, TERMINAL_DATA, TERMINAL_EXIT, TERMINAL_RESIZE } from './dock-terminal.service';

const dockId = '33333333-3333-4333-8333-333333333333';
const origin = 'http://localhost:3002';

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

describe('DockTerminalService', () => {
  let execs: any;
  let queue: any;
  let limits: any;
  let redis: any;
  let store: Map<string, string>;
  let config: any;
  let tunnels: any;
  let service: DockTerminalService;
  let server: Server;
  let base: string;
  let opens: Array<{ hostId: string; payload: any; token: string; deferred: Deferred }>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    store = new Map();
    opens = [];
    execs = { loadExecutableDock: vi.fn().mockResolvedValue({ id: dockId, hostId: 'h1', state: 'ready' }) };
    queue = {
      authenticateHost: vi.fn(async (token?: string) => {
        const match = /^host-cred-(.+)$/.exec(token ?? '');
        if (!match) throw new UnauthorizedException();
        return match[1];
      }),
      execute: vi.fn(
        (hostId: string, _op: string, payload: unknown, token: string) =>
          new Promise((resolve, reject) => opens.push({ hostId, payload, token, deferred: { resolve, reject } })),
      ),
    };
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    redis = {
      set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      getdel: vi.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      }),
    };
    config = { get: vi.fn((key: string) => ({ RUNTIME_DRIVER: 'restate' })[key]) };
    tunnels = { acceptHost: vi.fn((_req: unknown, socket: { destroy: () => void }) => socket.destroy()) };
    service = new DockTerminalService(execs, queue, limits, redis, config, tunnels);
    server = createServer();
    service.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    service.onModuleDestroy();
    await new Promise((resolve) => server.close(resolve));
  });

  function connect(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    const socket = new WebSocket(`${base}${path}`, { headers });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      socket.once('error', reject);
    });
  }

  async function browser(query = ''): Promise<WebSocket> {
    const { ticket } = await service.createTicket('u1', dockId);
    return connect(`/v1/docks/${dockId}/terminal?ticket=${ticket}${query}`, { origin });
  }

  async function waitForOpen(count = 1): Promise<(typeof opens)[number]> {
    await vi.waitFor(() => expect(opens.length).toBe(count));
    return opens[count - 1];
  }

  function host(open: (typeof opens)[number], overrides: Record<string, string> = {}): Promise<WebSocket> {
    return connect(`/v1/fleet/terminals/${open.payload.sessionId}`, {
      authorization: 'Bearer host-cred-h1',
      'x-terminal-secret': open.payload.secret,
      ...overrides,
    });
  }

  function nextMessage(socket: WebSocket): Promise<Buffer> {
    return new Promise((resolve) => socket.once('message', (data) => resolve(data as Buffer)));
  }

  function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1006, reason: '' });
    return new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  async function paired(): Promise<{ user: WebSocket; dock: WebSocket; open: (typeof opens)[number] }> {
    const user = await browser('&cols=120&rows=40');
    const open = await waitForOpen();
    const dock = await host(open);
    open.deferred.resolve({});
    return { user, dock, open };
  }

  it('issues a single-use ticket stored only as a hash with a short TTL', async () => {
    const res = await service.createTicket('u1', dockId);
    expect(res.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const [key, value, mode, ttl] = redis.set.mock.calls[0];
    expect(key).toMatch(/^terminal:ticket:/);
    expect(key).not.toContain(res.ticket);
    expect(JSON.parse(value)).toEqual({ userId: 'u1', dockId });
    expect([mode, ttl]).toEqual(['EX', 30]);
    expect(execs.loadExecutableDock).toHaveBeenCalledWith('u1', dockId);
  });

  it('refuses tickets outside fleet mode, for unplaced docks, and over the rate limit', async () => {
    config.get.mockReturnValue('fake');
    await expect(service.createTicket('u1', dockId)).rejects.toBeInstanceOf(ExecUnavailableException);
    config.get.mockReturnValue('restate');
    execs.loadExecutableDock.mockResolvedValueOnce({ id: dockId, hostId: null });
    await expect(service.createTicket('u1', dockId)).rejects.toBeInstanceOf(ExecUnavailableException);
    limits.hit.mockResolvedValueOnce({ allowed: false, count: 31 });
    const err = await service.createTicket('u1', dockId).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(limits.hit).toHaveBeenCalledWith('rl:terminal:caller:u1', 30, 60);
  });

  it('relays keystrokes and resizes to the host and output and exit back to the browser', async () => {
    const { user, dock, open } = await paired();
    expect(open.hostId).toBe('h1');
    expect(open.token).toBe(`terminal:${open.payload.sessionId}`);
    expect(open.payload).toMatchObject({ dockId, cols: 120, rows: 40 });
    expect(open.payload.secret).toMatch(/^[0-9a-f]{64}$/);

    const input = nextMessage(dock);
    user.send(Buffer.from([TERMINAL_DATA, ...Buffer.from('ls\n')]));
    expect((await input).toString('latin1')).toBe('\x00ls\n');
    const resize = nextMessage(dock);
    user.send(Buffer.from([TERMINAL_RESIZE, 0, 132, 0, 50]));
    expect([...(await resize)]).toEqual([TERMINAL_RESIZE, 0, 132, 0, 50]);

    const output = nextMessage(user);
    dock.send(Buffer.from([TERMINAL_DATA, ...Buffer.from('file.txt\r\n')]));
    expect((await output).subarray(1).toString()).toBe('file.txt\r\n');

    const exit = nextMessage(user);
    const userClosed = closed(user);
    const dockClosed = closed(dock);
    dock.send(Buffer.from([TERMINAL_EXIT, 0, 0, 0, 0]));
    expect((await exit)[0]).toBe(TERMINAL_EXIT);
    expect(await userClosed).toEqual({ code: 1000, reason: 'Shell exited' });
    await dockClosed;
  });

  it('serves non-browser clients such as SSH channels through the same relay', async () => {
    const received: Buffer[] = [];
    const client = { send: vi.fn((m: Buffer, sent: () => void) => (received.push(m), sent())), buffered: () => 0, heartbeat: () => true, close: vi.fn() };
    const handle = await service.openClient('u1', dockId, 100, 30, client);
    const open = await waitForOpen();
    expect(open.payload).toMatchObject({ dockId, cols: 100, rows: 30 });
    handle.input(Buffer.from([TERMINAL_DATA, 0x61]));
    const dock = new WebSocket(`${base}/v1/fleet/terminals/${open.payload.sessionId}`, {
      headers: { authorization: 'Bearer host-cred-h1', 'x-terminal-secret': open.payload.secret },
    });
    sockets.push(dock);
    expect([...(await nextMessage(dock))]).toEqual([TERMINAL_DATA, 0x61]);
    dock.send(Buffer.from([TERMINAL_DATA, 0x62]));
    await vi.waitFor(() => expect(received.map((m) => [...m])).toEqual([[TERMINAL_DATA, 0x62]]));
    const dockClosed = closed(dock);
    handle.hangUp();
    await dockClosed;
    expect(client.close).toHaveBeenCalledWith(1000, '');
  });

  it('refuses non-browser clients for docks that cannot serve terminals or over the cap', async () => {
    const client = { send: vi.fn(), buffered: () => 0, heartbeat: () => true, close: vi.fn() };
    execs.loadExecutableDock.mockResolvedValueOnce({ id: dockId, hostId: null });
    await expect(service.openClient('u1', dockId, 80, 24, client)).rejects.toBeInstanceOf(ExecUnavailableException);
    for (let i = 0; i < MAX_TERMINALS_PER_DOCK; i++) await service.openClient('u1', dockId, 80, 24, client);
    const err = await service.openClient('u1', dockId, 80, 24, client).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('holds early browser input until the host attaches', async () => {
    const user = await browser();
    const open = await waitForOpen();
    user.send(Buffer.from([TERMINAL_DATA, 0x61]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Listen before the handshake: the flush can share a packet with the 101 response.
    const dock = new WebSocket(`${base}/v1/fleet/terminals/${open.payload.sessionId}`, {
      headers: { authorization: 'Bearer host-cred-h1', 'x-terminal-secret': open.payload.secret },
    });
    sockets.push(dock);
    expect([...(await nextMessage(dock))]).toEqual([TERMINAL_DATA, 0x61]);
  });

  it('accepts each ticket once and only for its dock', async () => {
    const { ticket } = await service.createTicket('u1', dockId);
    await connect(`/v1/docks/${dockId}/terminal?ticket=${ticket}`, { origin });
    await expect(connect(`/v1/docks/${dockId}/terminal?ticket=${ticket}`, { origin })).rejects.toThrow('HTTP 401');
    const other = await service.createTicket('u1', dockId);
    await expect(connect(`/v1/docks/44444444-4444-4444-8444-444444444444/terminal?ticket=${other.ticket}`, { origin })).rejects.toThrow('HTTP 401');
    await expect(connect(`/v1/docks/${dockId}/terminal`, { origin })).rejects.toThrow('HTTP 401');
  });

  it('refuses browsers on untrusted origins', async () => {
    const { ticket } = await service.createTicket('u1', dockId);
    await expect(connect(`/v1/docks/${dockId}/terminal?ticket=${ticket}`, { origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    expect(store.size).toBe(1);
  });

  it('rechecks the dock when the ticket is redeemed', async () => {
    const { ticket } = await service.createTicket('u1', dockId);
    execs.loadExecutableDock.mockRejectedValueOnce(new ExecUnavailableException());
    await expect(connect(`/v1/docks/${dockId}/terminal?ticket=${ticket}`, { origin })).rejects.toThrow('HTTP 409');
    expect(queue.execute).not.toHaveBeenCalled();
  });

  it('caps open terminals per dock', async () => {
    for (let i = 0; i < MAX_TERMINALS_PER_DOCK; i++) await browser();
    const err = await service.createTicket('u1', dockId).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('admits only the owning host presenting its host credential and session secret', async () => {
    await browser();
    const open = await waitForOpen();
    await expect(host(open, { authorization: 'Bearer wrong' })).rejects.toThrow('HTTP 401');
    await expect(host(open, { 'x-terminal-secret': 'f'.repeat(64) })).rejects.toThrow('HTTP 403');
    await expect(host(open, { authorization: 'Bearer host-cred-h2' })).rejects.toThrow('HTTP 403');
    // A legacy X-Host-Id naming another host is refused; an absent or matching one is fine.
    await expect(host(open, { 'x-host-id': 'h2' })).rejects.toThrow('HTTP 403');
    await expect(connect('/v1/fleet/terminals/unknown', { authorization: 'Bearer host-cred-h1', 'x-terminal-secret': open.payload.secret })).rejects.toThrow('HTTP 403');
    await host(open);
    await expect(host(open)).rejects.toThrow('HTTP 403');
  });

  it('closes both legs when the browser sends anything but keystrokes or resizes', async () => {
    const { user, dock } = await paired();
    const userClosed = closed(user);
    const dockClosed = closed(dock);
    user.send(Buffer.from([TERMINAL_EXIT, 0, 0, 0, 0]));
    expect((await userClosed).code).toBe(1008);
    await dockClosed;
  });

  it('refuses text frames from the browser', async () => {
    const { user } = await paired();
    const userClosed = closed(user);
    user.send('ls');
    expect((await userClosed).code).toBe(1008);
  });

  it('hangs up the host when the browser leaves', async () => {
    const { user, dock } = await paired();
    const dockClosed = closed(dock);
    user.close();
    await dockClosed;
  });

  it('tells the browser when the dock agent has no terminal support', async () => {
    const user = await browser();
    const open = await waitForOpen();
    const userClosed = closed(user);
    open.deferred.reject(new CommandFailedException('terminal_unavailable', 'guest agent predates terminals'));
    const { code, reason } = await userClosed;
    expect(code).toBe(4003);
    expect(reason).toMatch(/stop and resume/);
  });

  it('closes the browser when the host reports success without attaching', async () => {
    const user = await browser();
    const open = await waitForOpen();
    const userClosed = closed(user);
    open.deferred.resolve({});
    expect((await userClosed).code).toBe(1011);
  });

  it('refuses unknown upgrade paths', async () => {
    await expect(connect('/v1/docks')).rejects.toThrow('HTTP 404');
  });

  it('hands port tunnel host legs to the tunnel service', async () => {
    await expect(connect('/v1/fleet/tunnels/t-1')).rejects.toThrow();
    expect(tunnels.acceptHost).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 't-1');
  });
});
