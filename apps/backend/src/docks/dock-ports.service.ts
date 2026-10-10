import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { createServer, type Server, type Socket } from 'net';
import { portsDomain, publicApiUrl } from '../config/instance';
import { DB, Db } from '../database/database.module';
import { dockPorts, docks, type DockPort } from '../database/schema';
import { EXEC_STATES } from './dock-exec.service';
import { DockTunnelService, TunnelOpenException, type TunnelFailure } from './dock-tunnel.service';
import { DocksService } from './docks.service';

export const MAX_PORTS_PER_DOCK = 10;
/** The guest agent's own port is never reachable from outside. */
const RESERVED_PORTS = [2222];
const LABEL_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const LABEL_RANDOM_CHARS = 16;
const MAX_HEAD_BYTES = 64 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 4096;

export interface DockPortView {
  port: number;
  /** Null while hosted ports are off on this deployment. */
  url: string | null;
  createdAt: Date;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  431: 'Request Header Fields Too Large',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const FAILURE_STATUS: Record<TunnelFailure, number> = { port_closed: 502, unavailable: 503, busy: 503, timeout: 504, failed: 502 };

function randomLabel(port: number): string {
  const bytes = randomBytes(LABEL_RANDOM_CHARS);
  let suffix = '';
  for (const byte of bytes) suffix += LABEL_ALPHABET[byte & 31];
  return `${port}-${suffix}`;
}

/** The single Host header of a raw request head; null when missing or repeated. */
export function hostHeader(head: string): string | null {
  const hosts = head
    .split('\r\n')
    .slice(1)
    .filter((line) => /^host:/i.test(line))
    .map((line) => line.slice(5).trim());
  return hosts.length === 1 ? hosts[0] : null;
}

function respond(client: Socket, status: number, text: string): void {
  const body = `${text}\n`;
  client.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
  );
}

/**
 * Hosted ports: a dock port exposed at `https://<port>-<random>.<PORTS_DOMAIN>`.
 * The edge proxy terminates TLS and forwards one request per connection to a
 * plain TCP listener here; only the Host header is read before the bytes are
 * spliced onto a tunnel to the dock, so HTTP, WebSockets, and streaming pass
 * through untouched.
 */
@Injectable()
export class DockPortsService implements OnModuleDestroy {
  private readonly logger = new Logger(DockPortsService.name);
  private server: Server | null = null;
  private connections = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    private readonly tunnels: DockTunnelService,
    private readonly config: ConfigService,
  ) {}

  async list(callerId: string, dockId: string): Promise<DockPortView[]> {
    const { dock } = await this.docks.loadReadableDock(callerId, dockId);
    const rows = await this.db.select().from(dockPorts).where(eq(dockPorts.dockId, dock.id)).orderBy(asc(dockPorts.port));
    return rows.map((row) => this.view(row));
  }

  /** Exposes a port; exposing it again returns the existing URL. */
  async expose(callerId: string, dockId: string, port: number): Promise<DockPortView> {
    if (!this.domain()) {
      throw new ServiceUnavailableException({ code: 'ports_unavailable', message: 'Hosted ports are not configured on this deployment' });
    }
    if (RESERVED_PORTS.includes(port)) {
      throw new BadRequestException({ code: 'validation_error', message: `Port ${port} is reserved for the dock agent` });
    }
    const { dock } = await this.docks.loadReadableDock(callerId, dockId);
    const existing = await this.findPort(dock.id, port);
    if (existing) return this.view(existing);
    const [{ total }] = await this.db.select({ total: count() }).from(dockPorts).where(eq(dockPorts.dockId, dock.id));
    if (total >= MAX_PORTS_PER_DOCK) {
      throw new ConflictException({ code: 'port_limit_reached', message: `A dock exposes at most ${MAX_PORTS_PER_DOCK} ports` });
    }
    const [row] = await this.db
      .insert(dockPorts)
      .values({ dockId: dock.id, port, label: randomLabel(port) })
      .onConflictDoNothing({ target: [dockPorts.dockId, dockPorts.port] })
      .returning();
    // A concurrent expose of the same port won the insert.
    return this.view(row ?? (await this.findPort(dock.id, port)) as DockPort);
  }

  /** Unexposes a port; its URL stops resolving at once. */
  async remove(callerId: string, dockId: string, port: number): Promise<{ deleted: boolean }> {
    const { dock } = await this.docks.loadReadableDock(callerId, dockId);
    const rows = await this.db
      .delete(dockPorts)
      .where(and(eq(dockPorts.dockId, dock.id), eq(dockPorts.port, port)))
      .returning({ id: dockPorts.id });
    if (!rows[0]) throw new NotFoundException({ code: 'port_not_found', message: `Port ${port} is not exposed` });
    return { deleted: true };
  }

  /** Edge TLS gate: certificates are issued only for exposed port hostnames. */
  async hostnameExposed(hostname: string): Promise<boolean> {
    const label = this.labelFor(hostname);
    if (!label) return false;
    const [row] = await this.db.select({ id: dockPorts.id }).from(dockPorts).where(eq(dockPorts.label, label)).limit(1);
    return Boolean(row);
  }

  async listen(host = '0.0.0.0'): Promise<number | null> {
    if (!this.domain()) return null;
    const port = this.config.get<number | string>('PORTS_PROXY_PORT');
    const server = createServer((client) => this.accept(client));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, () => resolve());
    });
    const bound = (server.address() as { port: number }).port;
    this.logger.log(`Ports proxy listening on ${host}:${bound} for *.${this.domain()}`);
    return bound;
  }

  onModuleDestroy(): void {
    this.server?.close();
    this.server = null;
  }

  private domain(): string | null {
    return portsDomain(this.config);
  }

  private view(row: DockPort): DockPortView {
    const domain = this.domain();
    // Port names are served on the same scheme and edge port as the public URL.
    const { protocol, port } = new URL(publicApiUrl(this.config));
    return { port: row.port, url: domain ? `${protocol}//${row.label}.${domain}${port ? `:${port}` : ''}` : null, createdAt: row.createdAt };
  }

  private async findPort(dockId: string, port: number): Promise<DockPort | null> {
    const rows = await this.db
      .select()
      .from(dockPorts)
      .where(and(eq(dockPorts.dockId, dockId), eq(dockPorts.port, port)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The label of `<label>.<domain>`, or null for any other hostname. */
  private labelFor(hostname: string): string | null {
    const domain = this.domain();
    const name = hostname.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!domain || !name.endsWith(`.${domain}`)) return null;
    const label = name.slice(0, -(domain.length + 1));
    return /^\d{1,5}-[a-z0-9]{1,32}$/.test(label) ? label : null;
  }

  private accept(client: Socket): void {
    client.on('error', () => undefined);
    if (this.connections >= MAX_CONNECTIONS) return respond(client, 503, 'Too many open connections');
    this.connections += 1;
    client.once('close', () => (this.connections -= 1));
    client.setNoDelay(true);
    const timer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1 && head.length <= MAX_HEAD_BYTES) return;
      client.off('data', onData);
      client.pause();
      clearTimeout(timer);
      if (end === -1) return respond(client, 431, 'Request headers too large');
      this.route(client, head, head.subarray(0, end).toString('latin1')).catch((err: unknown) => {
        this.logger.warn(`Port request failed: ${(err as Error).message}`);
        respond(client, 502, 'The dock port could not be reached');
      });
    };
    client.on('data', onData);
    client.once('close', () => clearTimeout(timer));
  }

  private async route(client: Socket, buffered: Buffer, head: string): Promise<void> {
    const hostname = hostHeader(head);
    if (!hostname) return respond(client, 400, 'Missing Host header');
    const label = this.labelFor(hostname);
    const [target] = label
      ? await this.db
          .select({ port: dockPorts.port, dockId: docks.id, state: docks.state, hostId: docks.hostId, billingPausedAt: docks.billingPausedAt })
          .from(dockPorts)
          .innerJoin(docks, eq(docks.id, dockPorts.dockId))
          .where(eq(dockPorts.label, label))
          .limit(1)
      : [];
    if (!target) return respond(client, 404, 'No dock port is exposed at this address');
    const running = EXEC_STATES.includes(target.state) && !target.billingPausedAt && target.hostId && this.config.get<string>('RUNTIME_DRIVER') === 'restate';
    if (!running) return respond(client, 503, `This dock is not running; resume it to reach port ${target.port}`);
    let host;
    try {
      host = await this.tunnels.open(target.hostId as string, target.dockId, target.port);
    } catch (err) {
      if (err instanceof TunnelOpenException) return respond(client, FAILURE_STATUS[err.reason], err.message);
      throw err;
    }
    if (client.destroyed) {
      host.close();
      return;
    }
    this.tunnels.bridge(client, host, buffered);
  }
}
