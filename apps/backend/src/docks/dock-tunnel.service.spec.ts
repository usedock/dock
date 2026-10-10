import { UnauthorizedException } from '@nestjs/common';
import { createServer, type Server } from 'http';
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'net';
import { vi } from 'vitest';
import { WebSocket } from 'ws';
import { CommandFailedException, CommandTimeoutException } from '../fleet/host-command-queue';
import { DockTunnelService, MAX_TUNNELS_PER_DOCK, TUNNEL_CHUNK_BYTES, TunnelOpenException } from './dock-tunnel.service';

interface Open {
  hostId: string;
  payload: { dockId: string; sessionId: string; secret: string; port: number };
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

describe('DockTunnelService', () => {
  let queue: any;
  let service: DockTunnelService;
  let server: Server;
  let base: string;
  let opens: Open[];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    opens = [];
    queue = {
      authenticateHost: vi.fn(async (token?: string) => {
        const match = /^host-cred-(.+)$/.exec(token ?? '');
        if (!match) throw new UnauthorizedException();
        return match[1];
      }),
      execute: vi.fn(
        (hostId: string, _op: string, payload: Open['payload']) => new Promise((resolve, reject) => opens.push({ hostId, payload, resolve, reject })),
      ),
    };
    service = new DockTunnelService(queue);
    server = createServer();
    server.on('upgrade', (req, socket, head) => service.acceptHost(req, socket, head, req.url!.split('/').pop()!));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    service.onModuleDestroy();
    await new Promise((resolve) => server.close(resolve));
  });

  async function nextOpen(): Promise<Open> {
    for (let i = 0; i < 100 && !opens.length; i++) await new Promise((r) => setTimeout(r, 5));
    const open = opens.shift();
    if (!open) throw new Error('no tunnel.open queued');
    return open;
  }

  function attach(open: Open, headers: Record<string, string> = {}): Promise<WebSocket> {
    const host = new WebSocket(`${base}/v1/fleet/tunnels/${open.payload.sessionId}`, {
      headers: { authorization: `Bearer host-cred-${open.hostId}`, 'x-tunnel-secret': open.payload.secret, ...headers },
    });
    sockets.push(host);
    return new Promise((resolve, reject) => {
      host.once('open', () => resolve(host));
      host.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      host.once('error', reject);
    });
  }

  it('queues tunnel.open and resolves once the owning host attaches', async () => {
    const opening = service.open('h1', 'd1', 3000);
    const open = await nextOpen();
    expect(queue.execute).toHaveBeenCalledWith('h1', 'tunnel.open', expect.objectContaining({ dockId: 'd1', port: 3000 }), `tunnel:${open.payload.sessionId}`);
    expect(open.payload.secret).toMatch(/^[0-9a-f]{64}$/);
    await attach(open);
    await expect(opening).resolves.toBeDefined();
  });

  it('admits only the owning host with its host credential and tunnel secret, once', async () => {
    const opening = service.open('h1', 'd1', 3000);
    const open = await nextOpen();
    await expect(attach(open, { authorization: 'Bearer nope' })).rejects.toThrow('HTTP 401');
    await expect(attach(open, { 'x-tunnel-secret': 'f'.repeat(64) })).rejects.toThrow('HTTP 403');
    await expect(attach(open, { authorization: 'Bearer host-cred-h2' })).rejects.toThrow('HTTP 403');
    // A legacy X-Host-Id naming another host is refused; the credential alone decides otherwise.
    await expect(attach(open, { 'x-host-id': 'h2' })).rejects.toThrow('HTTP 403');
    await attach(open);
    await opening;
    await expect(attach(open)).rejects.toThrow('HTTP 403');
  });

  it.each([
    [new CommandFailedException('port_closed', 'nothing'), 'port_closed'],
    [new CommandFailedException('tunnel_unavailable', 'old agent'), 'unavailable'],
    [new CommandFailedException('host_busy', 'full'), 'busy'],
    [new CommandTimeoutException('tunnel.open'), 'timeout'],
    [new CommandFailedException('host_unreachable', 'no route'), 'failed'],
  ])('maps a host failure to a reason', async (err, reason) => {
    const opening = service.open('h1', 'd1', 3000);
    (await nextOpen()).reject(err);
    await expect(opening).rejects.toMatchObject({ reason });
  });

  it('fails when the host reports success without attaching', async () => {
    const opening = service.open('h1', 'd1', 3000);
    (await nextOpen()).resolve({});
    await expect(opening).rejects.toBeInstanceOf(TunnelOpenException);
  });

  it('caps open tunnels per dock and frees slots as they close', async () => {
    const openings = Array.from({ length: MAX_TUNNELS_PER_DOCK }, () => service.open('h1', 'd1', 3000).catch(() => undefined));
    await expect(service.open('h1', 'd1', 3000)).rejects.toMatchObject({ reason: 'busy' });
    const otherDock = service.open('h1', 'd2', 3000).catch(() => undefined);
    for (const open of opens.splice(0)) open.reject(new CommandFailedException('port_closed', 'nothing'));
    await Promise.all([...openings, otherDock]);
    const freed = service.open('h1', 'd1', 3000);
    (await nextOpen()).reject(new CommandFailedException('port_closed', 'nothing'));
    await expect(freed).rejects.toMatchObject({ reason: 'port_closed' });
  });

  describe('bridge', () => {
    let proxy: TcpServer;
    const clients: Socket[] = [];

    afterEach(async () => {
      for (const client of clients.splice(0)) client.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    });

    /** A client connection whose server side is bridged onto a fresh tunnel. */
    async function bridged(first: Buffer): Promise<{ client: Socket; host: WebSocket }> {
      const accepted = new Promise<Socket>((resolve) => {
        proxy = createTcpServer((socket) => resolve(socket));
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const client = connect((proxy.address() as AddressInfo).port, '127.0.0.1');
      clients.push(client);
      const serverSide = await accepted;
      serverSide.pause();
      const opening = service.open('h1', 'd1', 3000);
      const host = await attach(await nextOpen());
      service.bridge(serverSide, await opening, first);
      return { client, host };
    }

    it('relays bytes both ways in bounded messages', async () => {
      const { client, host } = await bridged(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
      const messages: Buffer[] = [];
      const got = new Promise<void>((resolve) =>
        host.on('message', (data: Buffer) => {
          messages.push(data);
          if (Buffer.concat(messages).length === 18 + 100_000) resolve();
        }),
      );
      client.write(Buffer.alloc(100_000, 1));
      await got;
      expect(Buffer.concat(messages).subarray(0, 18).toString()).toBe('GET / HTTP/1.1\r\n\r\n');
      expect(Math.max(...messages.map((m) => m.length))).toBeLessThanOrEqual(TUNNEL_CHUNK_BYTES);
      const reply = new Promise<string>((resolve) => client.once('data', (d) => resolve(d.toString())));
      host.send(Buffer.from('HTTP/1.1 200 OK\r\n'));
      expect(await reply).toBe('HTTP/1.1 200 OK\r\n');
    });

    it('closes the client when the host leg closes, and the host when the client leaves', async () => {
      const first = await bridged(Buffer.alloc(0));
      const ended = new Promise((resolve) => first.client.once('close', resolve));
      first.host.close();
      await ended;
      proxy.close();
      const second = await bridged(Buffer.alloc(0));
      const hostClosed = new Promise((resolve) => second.host.once('close', resolve));
      second.client.destroy();
      await hostClosed;
    });
  });
});
