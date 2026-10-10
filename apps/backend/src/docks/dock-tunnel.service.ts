import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { bearer, CommandTimeoutException, constantTimeEquals, HostCommandQueue, hostIdHeaderAgrees } from '../fleet/host-command-queue';

export const MAX_TUNNELS_PER_DOCK = 128;
export const MAX_TUNNELS = 4096;
/** One relayed message; the docklet refuses frames above 64 KiB. */
export const TUNNEL_CHUNK_BYTES = 32 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const HIGH_WATER = 1 << 20;
const HEARTBEAT_MS = 30_000;

export type TunnelFailure = 'port_closed' | 'unavailable' | 'busy' | 'timeout' | 'failed';

/** Why a tunnel to a dock port could not be opened. */
export class TunnelOpenException extends Error {
  constructor(
    readonly reason: TunnelFailure,
    message: string,
  ) {
    super(message);
  }
}

interface PendingTunnel {
  secret: string;
  hostId: string;
  attaching: boolean;
  settle: (result: WebSocket | TunnelOpenException) => void;
}

type Alive = WebSocket & { dockAlive?: boolean };

function reject(socket: Duplex, status: number, text: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Raw TCP streams to ports inside docks. The owning host connects to the guest
 * port, dials back on the fleet channel with a per-tunnel secret, and bytes are
 * relayed as binary messages. Payloads are never logged or inspected.
 */
@Injectable()
export class DockTunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(DockTunnelService.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly pending = new Map<string, PendingTunnel>();
  private readonly perDock = new Map<string, number>();
  private readonly live = new Set<Alive>();
  private total = 0;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly queue: HostCommandQueue) {
    this.sweeper = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    for (const host of this.live) host.terminate();
    this.wss.close();
  }

  /** Opens one stream to `port` on the dock's loopback; resolves once the host is connected. */
  async open(hostId: string, dockId: string, port: number): Promise<WebSocket> {
    const count = this.perDock.get(dockId) ?? 0;
    if (count >= MAX_TUNNELS_PER_DOCK || this.total >= MAX_TUNNELS) {
      throw new TunnelOpenException('busy', 'Too many open connections to this dock');
    }
    this.perDock.set(dockId, count + 1);
    this.total += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.perDock.get(dockId) ?? 1) - 1;
      if (left > 0) this.perDock.set(dockId, left);
      else this.perDock.delete(dockId);
    };
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const host = await new Promise<WebSocket>((resolve, fail) => {
      let settled = false;
      const settle = (result: WebSocket | TunnelOpenException) => {
        if (settled) {
          if (!(result instanceof TunnelOpenException)) result.close();
          return;
        }
        settled = true;
        this.pending.delete(id);
        if (result instanceof TunnelOpenException) {
          release();
          fail(result);
        } else {
          resolve(result);
        }
      };
      this.pending.set(id, { secret, hostId, attaching: false, settle });
      this.queue
        .execute(hostId, 'tunnel.open', { dockId, sessionId: id, secret, port }, `tunnel:${id}`)
        .then(() => settle(new TunnelOpenException('failed', 'The dock host did not connect')))
        .catch((err: unknown) => settle(this.failure(err, port)));
    });
    const alive = host as Alive;
    alive.dockAlive = true;
    this.live.add(alive);
    host.on('pong', () => (alive.dockAlive = true));
    host.once('close', () => {
      this.live.delete(alive);
      release();
    });
    return host;
  }

  /** Serves the host leg at /v1/fleet/tunnels/:id. */
  async acceptHost(req: IncomingMessage, socket: Duplex, head: Buffer, id: string): Promise<void> {
    let callerHostId: string;
    try {
      callerHostId = await this.queue.authenticateHost(bearer(req.headers.authorization));
    } catch {
      return reject(socket, 401, 'Unauthorized');
    }
    const tunnel = this.pending.get(id);
    const secret = req.headers['x-tunnel-secret'];
    if (
      !tunnel ||
      tunnel.attaching ||
      typeof secret !== 'string' ||
      !constantTimeEquals(secret, tunnel.secret) ||
      callerHostId !== tunnel.hostId ||
      !hostIdHeaderAgrees(req, callerHostId)
    ) {
      return reject(socket, 403, 'Forbidden');
    }
    tunnel.attaching = true;
    this.wss.handleUpgrade(req, socket, head, (host) => tunnel.settle(host));
  }

  /** Relays bytes between a client socket and an open tunnel; `first` was already read from the client. */
  bridge(client: Socket, host: WebSocket, first: Buffer): void {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      client.end(() => client.destroy());
      host.close();
    };
    const forward = (data: Buffer) => {
      for (let at = 0; at < data.length; at += TUNNEL_CHUNK_BYTES) {
        host.send(data.subarray(at, at + TUNNEL_CHUNK_BYTES), () => {
          if (client.isPaused() && host.bufferedAmount < HIGH_WATER / 2) client.resume();
        });
      }
      if (host.bufferedAmount > HIGH_WATER) client.pause();
    };
    const paused = host as WebSocket & { pause?: () => void; resume?: () => void };
    host.on('message', (data) => {
      if (!client.write(toBuffer(data))) paused.pause?.();
    });
    client.on('drain', () => paused.resume?.());
    client.on('data', forward);
    client.on('close', close);
    client.on('error', close);
    host.on('close', close);
    host.on('error', close);
    if (first.length) forward(first);
    client.resume();
  }

  private failure(err: unknown, port: number): TunnelOpenException {
    const code = (err as { code?: string }).code;
    if (code === 'port_closed') return new TunnelOpenException('port_closed', `Nothing is listening on port ${port} inside the dock`);
    if (code === 'tunnel_unavailable') return new TunnelOpenException('unavailable', 'Port forwarding is unavailable on this dock; stop and resume it to enable it');
    if (code === 'host_busy') return new TunnelOpenException('busy', 'The dock host has too many open connections');
    if (err instanceof CommandTimeoutException || code === 'host_timeout') return new TunnelOpenException('timeout', 'The dock host did not answer');
    return new TunnelOpenException('failed', 'The dock host could not open the port');
  }

  /** Drops host legs that stopped answering pings. */
  private sweep(): void {
    for (const host of this.live) {
      if (!host.dockAlive) {
        host.terminate();
        continue;
      }
      host.dockAlive = false;
      host.ping();
    }
  }
}
