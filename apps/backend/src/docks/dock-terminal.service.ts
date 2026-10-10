import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import type Redis from 'ioredis';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { RateLimitService } from '../auth/rate-limit.service';
import { authTrustedOrigins } from '../config/instance';
import { hashToken } from '../crypto/tokens';
import type { Dock } from '../database/schema';
import { bearer, CommandTimeoutException, constantTimeEquals, HostCommandQueue, hostIdHeaderAgrees } from '../fleet/host-command-queue';
import { REDIS } from '../redis/redis.module';
import { ExecRateLimitedException, ExecUnavailableException, TerminalLimitException } from './dock-errors';
import { DockExecService } from './dock-exec.service';
import { DockTunnelService } from './dock-tunnel.service';
import type { DockTerminalTicketDto } from './dto/terminal.dto';

export const TERMINAL_TICKET_TTL_SECONDS = 30;
const TERMINAL_TICKET_RATE = { limit: 30, windowSeconds: 60 };
export const MAX_TERMINALS_PER_DOCK = 4;
export const MAX_TERMINALS_PER_USER = 8;
const TERMINAL_IDLE_MS = 30 * 60_000;
const TERMINAL_MAX_MS = 12 * 60 * 60_000;
const HEARTBEAT_MS = 30_000;
/** One kind byte plus the docklet's 64 KiB frame limit. */
const MAX_MESSAGE_BYTES = 64 * 1024 + 1;
const MAX_PENDING_MESSAGES = 64;
const OUTPUT_HIGH_WATER = 1 << 20;
const OUTPUT_HARD_CAP = 16 << 20;

/** Message kinds: the first byte of every binary WebSocket message on both legs. */
export const TERMINAL_DATA = 0;
export const TERMINAL_RESIZE = 1;
export const TERMINAL_EXIT = 2;

/** Close codes the dashboard turns into a status line. */
export const TERMINAL_CLOSE = {
  exited: 1000,
  shutdown: 1001,
  policy: 1008,
  hostFailed: 1011,
  busy: 1013,
  idle: 4001,
  expired: 4002,
  unavailable: 4003,
} as const;

/** The user-facing leg of a terminal: a browser WebSocket or an SSH channel. */
export interface TerminalClient {
  /** Delivers one host frame (kind byte, payload); `sent` fires once it is flushed. */
  send(message: Buffer, sent: () => void): void;
  /** Bytes queued toward the user. */
  buffered(): number;
  /** False when the peer missed the last heartbeat; otherwise pings it. */
  heartbeat(): boolean;
  close(code: number, reason: string): void;
}

/** What a non-browser client drives an open terminal with. */
export interface TerminalHandle {
  /** Sends one keystroke or resize frame. */
  input(message: Buffer): void;
  hangUp(): void;
}

interface TerminalSession {
  id: string;
  secret: string;
  dockId: string;
  hostId: string;
  userId: string;
  openedAt: number;
  lastActivity: number;
  client: TerminalClient | null;
  host: WebSocket | null;
  hostAttaching: boolean;
  pending: Buffer[];
  closed: boolean;
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

function browserClient(browser: WebSocket): TerminalClient {
  const alive = browser as Alive;
  alive.dockAlive = true;
  browser.on('pong', () => (alive.dockAlive = true));
  return {
    send: (message, sent) => browser.send(message, () => sent()),
    buffered: () => browser.bufferedAmount,
    heartbeat: () => {
      if (!alive.dockAlive) return false;
      alive.dockAlive = false;
      browser.ping();
      return true;
    },
    close: (code, reason) => browser.close(code, reason),
  };
}

export function clampSize(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : fallback;
}

/**
 * Interactive dock shells. Browsers present a single-use ticket over WebSockets
 * and the SSH gateway opens sessions directly; the owning host dials back on the fleet channel with a per-session
 * secret, and frames are relayed between the two. Terminal content is never
 * logged or stored.
 */
@Injectable()
export class DockTerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(DockTerminalService.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly origins: string[];
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly execs: DockExecService,
    private readonly queue: HostCommandQueue,
    private readonly limits: RateLimitService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly tunnels: DockTunnelService,
  ) {
    this.origins = authTrustedOrigins(config);
    this.sweeper = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) this.end(session, 'server shutdown', TERMINAL_CLOSE.shutdown, 'Server restarting');
    this.wss.close();
  }

  /** Issues a short-lived ticket bound to this caller and dock. */
  async createTicket(callerId: string, id: string): Promise<DockTerminalTicketDto> {
    const dock = await this.loadTerminalDock(callerId, id);
    if (this.atCapacity(callerId, dock.id)) throw new TerminalLimitException();
    const { allowed } = await this.limits.hit(`rl:terminal:caller:${callerId}`, TERMINAL_TICKET_RATE.limit, TERMINAL_TICKET_RATE.windowSeconds);
    if (!allowed) throw new ExecRateLimitedException();
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.set(`terminal:ticket:${hashToken(ticket)}`, JSON.stringify({ userId: callerId, dockId: dock.id }), 'EX', TERMINAL_TICKET_TTL_SECONDS);
    return { ticket, expiresAt: new Date(Date.now() + TERMINAL_TICKET_TTL_SECONDS * 1000).toISOString() };
  }

  /** Opens a terminal for a non-browser client such as an SSH channel; throws when the dock cannot serve one. */
  async openClient(userId: string, dockId: string, cols: number, rows: number, client: TerminalClient): Promise<TerminalHandle> {
    const dock = await this.loadTerminalDock(userId, dockId);
    if (this.atCapacity(userId, dock.id)) throw new TerminalLimitException();
    const session = this.reserve(userId, dock);
    this.start(session, client, cols, rows);
    return {
      input: (message) => this.fromClient(session, message, true),
      hangUp: () => this.end(session, 'client closed'),
    };
  }

  /** Serves terminal and port tunnel upgrades on the API's HTTP server; any other upgrade is refused. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => undefined);
      this.route(req, socket, head).catch((err: unknown) => {
        this.logger.warn(`Terminal upgrade failed: ${(err as Error).message}`);
        reject(socket, 500, 'Internal Server Error');
      });
    });
  }

  private async loadTerminalDock(callerId: string, id: string): Promise<Dock> {
    const dock = await this.execs.loadExecutableDock(callerId, id);
    if (this.config.get<string>('RUNTIME_DRIVER') !== 'restate' || !dock.hostId) {
      throw new ExecUnavailableException('Terminals need a dock running on a fleet host');
    }
    return dock;
  }

  private atCapacity(userId: string, dockId: string): boolean {
    const live = [...this.sessions.values()];
    return (
      live.filter((s) => s.dockId === dockId).length >= MAX_TERMINALS_PER_DOCK ||
      live.filter((s) => s.userId === userId).length >= MAX_TERMINALS_PER_USER
    );
  }

  private async route(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const browserPath = /^\/v1\/docks\/([^/]+)\/terminal$/.exec(url.pathname);
    if (browserPath) return this.acceptBrowser(req, socket, head, decodeURIComponent(browserPath[1]), url.searchParams);
    const hostPath = /^\/v1\/fleet\/terminals\/([^/]+)$/.exec(url.pathname);
    if (hostPath) return this.acceptHost(req, socket, head, decodeURIComponent(hostPath[1]));
    const tunnelPath = /^\/v1\/fleet\/tunnels\/([^/]+)$/.exec(url.pathname);
    if (tunnelPath) return this.tunnels.acceptHost(req, socket, head, decodeURIComponent(tunnelPath[1]));
    reject(socket, 404, 'Not Found');
  }

  private async acceptBrowser(req: IncomingMessage, socket: Duplex, head: Buffer, dockId: string, params: URLSearchParams): Promise<void> {
    // The ticket is the credential; the origin check still blocks pages on other sites.
    const origin = req.headers.origin;
    if (origin && !this.origins.includes(origin)) return reject(socket, 403, 'Forbidden');
    const ticket = params.get('ticket') ?? '';
    if (!ticket || ticket.length > 128) return reject(socket, 401, 'Unauthorized');
    const raw = await this.redis.getdel(`terminal:ticket:${hashToken(ticket)}`);
    const claim = raw ? (JSON.parse(raw) as { userId: string; dockId: string }) : null;
    if (!claim || claim.dockId !== dockId) return reject(socket, 401, 'Unauthorized');
    let dock: Dock;
    try {
      dock = await this.loadTerminalDock(claim.userId, dockId);
    } catch {
      return reject(socket, 409, 'Conflict');
    }
    if (this.atCapacity(claim.userId, dock.id)) return reject(socket, 429, 'Too Many Requests');
    // Reserved before the handshake so concurrent upgrades cannot exceed the caps.
    const session = this.reserve(claim.userId, dock);
    socket.once('close', () => {
      if (!session.client) this.end(session, 'handshake failed');
    });
    const cols = clampSize(params.get('cols'), 80);
    const rows = clampSize(params.get('rows'), 24);
    this.wss.handleUpgrade(req, socket, head, (browser) => {
      browser.on('message', (data, isBinary) => this.fromClient(session, toBuffer(data), isBinary));
      browser.on('close', () => this.end(session, 'browser closed'));
      browser.on('error', () => this.end(session, 'browser error'));
      this.start(session, browserClient(browser), cols, rows);
    });
  }

  private reserve(userId: string, dock: Dock): TerminalSession {
    const session: TerminalSession = {
      id: randomUUID(),
      secret: randomBytes(32).toString('hex'),
      dockId: dock.id,
      hostId: dock.hostId as string,
      userId,
      openedAt: Date.now(),
      lastActivity: Date.now(),
      client: null,
      host: null,
      hostAttaching: false,
      pending: [],
      closed: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private start(session: TerminalSession, client: TerminalClient, cols: number, rows: number): void {
    session.client = client;
    if (session.closed) return;
    this.logger.log(`Terminal ${session.id} opening on dock ${session.dockId} for user ${session.userId}`);
    this.queue
      .execute(session.hostId, 'terminal.open', { dockId: session.dockId, sessionId: session.id, secret: session.secret, cols, rows }, `terminal:${session.id}`)
      .then(() => {
        if (!session.host) this.end(session, 'host never attached', TERMINAL_CLOSE.hostFailed, 'The dock host did not connect');
      })
      .catch((err: unknown) => {
        const code = (err as { code?: string }).code;
        if (code === 'terminal_unavailable') {
          this.end(session, 'agent without terminals', TERMINAL_CLOSE.unavailable, 'Terminal is unavailable on this dock; stop and resume it to enable it');
        } else if (code === 'host_busy') {
          this.end(session, 'host busy', TERMINAL_CLOSE.busy, 'The dock host has too many open terminals');
        } else if (err instanceof CommandTimeoutException || code === 'host_timeout') {
          this.end(session, 'host timeout', TERMINAL_CLOSE.hostFailed, 'The dock host did not answer');
        } else {
          this.end(session, `open failed: ${code ?? 'error'}`, TERMINAL_CLOSE.hostFailed, 'The dock host could not open a terminal');
        }
      });
  }

  private async acceptHost(req: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): Promise<void> {
    let callerHostId: string;
    try {
      callerHostId = await this.queue.authenticateHost(bearer(req.headers.authorization));
    } catch {
      return reject(socket, 401, 'Unauthorized');
    }
    const session = this.sessions.get(sessionId);
    const secret = req.headers['x-terminal-secret'];
    if (
      !session ||
      session.closed ||
      !session.client ||
      session.hostAttaching ||
      typeof secret !== 'string' ||
      !constantTimeEquals(secret, session.secret) ||
      callerHostId !== session.hostId ||
      !hostIdHeaderAgrees(req, callerHostId)
    ) {
      return reject(socket, 403, 'Forbidden');
    }
    session.hostAttaching = true;
    this.wss.handleUpgrade(req, socket, head, (host) => this.pair(session, host));
  }

  private pair(session: TerminalSession, host: WebSocket): void {
    session.host = host;
    (host as Alive).dockAlive = true;
    host.on('pong', () => ((host as Alive).dockAlive = true));
    host.on('message', (data, isBinary) => this.fromHost(session, toBuffer(data), isBinary));
    host.on('close', () => this.end(session, 'host closed', TERMINAL_CLOSE.hostFailed, 'The dock connection closed'));
    host.on('error', () => this.end(session, 'host error', TERMINAL_CLOSE.hostFailed, 'The dock connection failed'));
    if (session.closed) {
      host.close();
      return;
    }
    for (const message of session.pending) host.send(message);
    session.pending = [];
    this.logger.log(`Terminal ${session.id} connected to host ${session.hostId}`);
  }

  /** Clients may only send keystrokes and resizes. */
  private fromClient(session: TerminalSession, message: Buffer, isBinary: boolean): void {
    if (session.closed) return;
    const kind = message[0];
    const valid =
      isBinary && message.length >= 1 && message.length <= MAX_MESSAGE_BYTES && (kind === TERMINAL_DATA || (kind === TERMINAL_RESIZE && message.length === 5));
    if (!valid) return this.end(session, 'invalid client frame', TERMINAL_CLOSE.policy, 'Unsupported terminal message');
    session.lastActivity = Date.now();
    if (session.host) {
      session.host.send(message);
      if (session.host.bufferedAmount > OUTPUT_HARD_CAP) this.end(session, 'input outran host', TERMINAL_CLOSE.busy, 'Terminal input outran the dock connection');
    } else if (session.pending.length < MAX_PENDING_MESSAGES) {
      session.pending.push(message);
    } else {
      this.end(session, 'input before connect', TERMINAL_CLOSE.policy, 'Too much input before the dock connected');
    }
  }

  /** Hosts may only send shell output and the exit status. */
  private fromHost(session: TerminalSession, message: Buffer, isBinary: boolean): void {
    const client = session.client;
    const kind = message[0];
    if (!client || !isBinary || (kind !== TERMINAL_DATA && kind !== TERMINAL_EXIT)) {
      return this.end(session, 'invalid host frame', TERMINAL_CLOSE.hostFailed, 'The dock sent an invalid message');
    }
    session.lastActivity = Date.now();
    if (kind === TERMINAL_EXIT) {
      // ws sends queued frames in order, so the exit status precedes the close.
      client.send(message, () => undefined);
      return this.end(session, 'shell exited', TERMINAL_CLOSE.exited, 'Shell exited');
    }
    const host = session.host as WebSocket & { pause?: () => void; resume?: () => void };
    client.send(message, () => {
      if (host.isPaused && client.buffered() < OUTPUT_HIGH_WATER / 2) host.resume?.();
    });
    if (client.buffered() > OUTPUT_HIGH_WATER && host.pause) {
      host.pause();
    } else if (client.buffered() > OUTPUT_HARD_CAP) {
      this.end(session, 'client too slow', TERMINAL_CLOSE.busy, 'Terminal output outran the connection');
    }
  }

  /** Pings both legs, drops dead peers, and enforces the idle and lifetime limits. */
  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.openedAt > TERMINAL_MAX_MS) {
        this.end(session, 'lifetime', TERMINAL_CLOSE.expired, 'Terminal session reached its 12 hour limit');
        continue;
      }
      if (now - session.lastActivity > TERMINAL_IDLE_MS) {
        this.end(session, 'idle', TERMINAL_CLOSE.idle, 'Terminal closed after 30 minutes idle');
        continue;
      }
      if (session.client && !session.client.heartbeat()) {
        this.end(session, 'client unresponsive', TERMINAL_CLOSE.hostFailed, 'Terminal connection stopped responding');
        continue;
      }
      const host = session.host as Alive | null;
      if (!host) continue;
      if (!host.dockAlive) {
        this.end(session, 'host unresponsive', TERMINAL_CLOSE.hostFailed, 'Terminal connection stopped responding');
        continue;
      }
      host.dockAlive = false;
      host.ping();
    }
  }

  private end(session: TerminalSession, why: string, code: number = TERMINAL_CLOSE.exited, reason = ''): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    session.pending = [];
    session.client?.close(code, reason);
    session.host?.close(TERMINAL_CLOSE.exited);
    const seconds = Math.round((Date.now() - session.openedAt) / 1000);
    this.logger.log(`Terminal ${session.id} on dock ${session.dockId} closed after ${seconds}s: ${why}`);
  }
}
