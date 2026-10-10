import { forwardRef, HttpException, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, utils, type AuthContext, type Connection, type ServerChannel, type Session } from 'ssh2';
import { AccountClosedException, AccountClosureService } from '../account-closure/account-closure.service';
import { SshConnectionRegistry } from '../account-closure/ssh-connection-registry';
import { RateLimitService } from '../auth/rate-limit.service';
import { SshKeysService } from '../ssh-keys/ssh-keys.service';
import { ExecTimeoutException } from './dock-errors';
import { DockExecService } from './dock-exec.service';
import {
  clampSize,
  DockTerminalService,
  TERMINAL_CLOSE,
  TERMINAL_DATA,
  TERMINAL_EXIT,
  TERMINAL_RESIZE,
  type TerminalClient,
  type TerminalHandle,
} from './dock-terminal.service';
import { DocksService } from './docks.service';
import { sshHostKey } from './ssh-host-key';

const AUTH_TIMEOUT_MS = 30_000;
const AUTH_RATE = { limit: 60, windowSeconds: 60 };
const MAX_CONNECTIONS = 500;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_SESSIONS_PER_CONNECTION = 4;
/** Keeps each keystroke frame within the docklet's 64 KiB frame limit. */
const MAX_INPUT_CHUNK = 32 * 1024;

const UNSUPPORTED_FILE_TRANSFER = 'SCP and SFTP are not available yet; use the exec API to move files.';

interface Caller {
  userId: string;
  dockId: string;
  keyId: string;
}

function resizeFrame(cols: number, rows: number): Buffer {
  const frame = Buffer.alloc(5);
  frame[0] = TERMINAL_RESIZE;
  frame.writeUInt16BE(clampSize(String(cols), 80), 1);
  frame.writeUInt16BE(clampSize(String(rows), 24), 3);
  return frame;
}

function errorText(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse() as { message?: string } | string;
    return typeof body === 'string' ? body : (body.message ?? err.message);
  }
  return 'The dock could not be reached';
}

function fail(channel: ServerChannel, message: string, code = 1): void {
  channel.stderr.write(`${message}\r\n`);
  channel.exit(code);
  channel.end();
}

/**
 * SSH into docks as `ssh <dockId>@<gateway>`. Users authenticate with their
 * registered public keys; shells ride the terminal relay and commands run
 * through the exec API, so hosts still only dial out. No forwarding, agent, X11,
 * or file transfer.
 */
@Injectable()
export class DockSshGatewayService implements OnModuleDestroy {
  private readonly logger = new Logger(DockSshGatewayService.name);
  private server: Server | null = null;
  private readonly perIp = new Map<string, number>();
  private connections = 0;

  constructor(
    private readonly keys: SshKeysService,
    private readonly docks: DocksService,
    private readonly execs: DockExecService,
    private readonly terminals: DockTerminalService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => AccountClosureService)) private readonly closures: AccountClosureService,
    private readonly registry: SshConnectionRegistry,
  ) {}

  /** Listens on SSH_GATEWAY_PORT; a no-op when it is unset. Resolves the bound port. */
  async listen(host = '0.0.0.0'): Promise<number | null> {
    const port = this.config.get<number>('SSH_GATEWAY_PORT');
    if (port === undefined || port === null) return null;
    const server = new Server({ hostKeys: [sshHostKey(this.config)], ident: 'Dock', keepaliveInterval: 30_000, keepaliveCountMax: 3 }, (conn, info) =>
      this.accept(conn, info.ip),
    );
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, () => resolve());
    });
    const bound = (server.address() as { port: number }).port;
    this.logger.log(`SSH gateway listening on ${host}:${bound}`);
    return bound;
  }

  onModuleDestroy(): void {
    this.server?.close();
    this.server = null;
  }

  private accept(conn: Connection, ip: string): void {
    conn.on('error', () => undefined);
    const fromIp = this.perIp.get(ip) ?? 0;
    if (this.connections >= MAX_CONNECTIONS || fromIp >= MAX_CONNECTIONS_PER_IP) {
      conn.end();
      return;
    }
    this.connections++;
    this.perIp.set(ip, fromIp + 1);
    let caller: Caller | null = null;
    let untrack: (() => void) | null = null;
    const authTimer = setTimeout(() => conn.end(), AUTH_TIMEOUT_MS);
    authTimer.unref();
    conn.on('close', () => {
      clearTimeout(authTimer);
      untrack?.();
      this.connections--;
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left > 0) this.perIp.set(ip, left);
      else this.perIp.delete(ip);
    });
    conn.on('authentication', (ctx) => {
      this.authenticate(ctx, ip)
        .then((found) => {
          if (!found) return ctx.reject(['publickey']);
          if (ctx.method === 'publickey' && !ctx.signature) return ctx.accept();
          caller = found;
          ctx.accept();
        })
        .catch((err: unknown) => {
          this.logger.warn(`SSH auth from ${ip} failed: ${(err as Error).message}`);
          ctx.reject(['publickey']);
        });
    });
    conn.on('ready', () => {
      clearTimeout(authTimer);
      if (!caller) return conn.end();
      const who = caller;
      untrack = this.registry.register(who.userId, () => conn.end());
      this.logger.log(`SSH connection for user ${who.userId} on dock ${who.dockId} from ${ip} with key ${who.keyId}`);
      void this.keys.touch(who.keyId).catch(() => undefined);
      let sessions = 0;
      conn.on('session', (acceptSession, rejectSession) => {
        if (sessions >= MAX_SESSIONS_PER_CONNECTION) return rejectSession();
        sessions++;
        const session = acceptSession();
        session.once('close', () => sessions--);
        this.serve(session, who);
      });
      conn.on('tcpip', (_accept, rejectForward) => rejectForward());
      conn.on('request', (_accept, rejectRequest) => rejectRequest?.());
    });
  }

  /** Resolves the caller when the key belongs to someone who can see the dock; signature-less probes skip verification. */
  private async authenticate(ctx: AuthContext, ip: string): Promise<Caller | null> {
    if (ctx.method !== 'publickey') return null;
    const { allowed } = await this.limits.hit(`rl:ssh:auth:${ip}`, AUTH_RATE.limit, AUTH_RATE.windowSeconds);
    if (!allowed) return null;
    const dockId = ctx.username.trim();
    for (const row of await this.keys.findByBlob(ctx.key.data)) {
      const stored = utils.parseKey(row.publicKey);
      if (stored instanceof Error || Array.isArray(stored) || !stored.getPublicSSH().equals(ctx.key.data)) continue;
      if (ctx.signature && ctx.blob && stored.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) continue;
      try {
        // Closed or erased accounts lose SSH access even if a key row survives.
        if ((await this.closures.guardCheck(row.userId)) !== 'ok') continue;
        await this.docks.loadReadableDock(row.userId, dockId);
        return { userId: row.userId, dockId, keyId: row.id };
      } catch {
        continue;
      }
    }
    return null;
  }

  private serve(session: Session, caller: Caller): void {
    let size = { cols: 80, rows: 24 };
    let terminal: TerminalHandle | null = null;
    let started = false;
    session.on('pty', (accept, _reject, info) => {
      size = { cols: info.cols, rows: info.rows };
      accept?.();
    });
    session.on('window-change', (accept, _reject, info) => {
      size = { cols: info.cols, rows: info.rows };
      terminal?.input(resizeFrame(info.cols, info.rows));
      accept?.();
    });
    session.on('env', (accept) => accept?.());
    session.on('shell', (accept, reject) => {
      if (started) return reject?.();
      started = true;
      const channel = accept();
      this.shell(channel, caller, size).then((handle) => (terminal = handle));
    });
    session.on('exec', (accept, reject, info) => {
      if (started) return reject?.();
      started = true;
      void this.exec(accept(), caller, info.command);
    });
    session.on('subsystem', (accept, reject, info) => {
      if (info.name !== 'sftp' || started) return reject?.();
      started = true;
      fail(accept(), UNSUPPORTED_FILE_TRANSFER);
    });
    session.on('auth-agent', (_accept, reject) => reject?.());
    session.on('x11', (_accept, reject) => reject?.());
    session.on('signal', (accept) => accept?.());
  }

  private async shell(channel: ServerChannel, caller: Caller, size: { cols: number; rows: number }): Promise<TerminalHandle | null> {
    let closed = false;
    const client: TerminalClient = {
      send: (message, sent) => {
        if (closed) return sent();
        if (message[0] === TERMINAL_DATA) {
          channel.write(message.subarray(1), () => sent());
          return;
        }
        if (message[0] === TERMINAL_EXIT && message.length === 5) channel.exit(message.readInt32BE(1));
        sent();
      },
      buffered: () => channel.writableLength,
      // ssh2 keepalives drop dead peers, which hangs the terminal up.
      heartbeat: () => true,
      close: (code, reason) => {
        if (closed) return;
        closed = true;
        if (code !== TERMINAL_CLOSE.exited && reason) channel.stderr.write(`\r\n${reason}\r\n`);
        channel.end();
      },
    };
    // Listeners go on before the dock is resolved so early keystrokes and hang-ups are not lost.
    let handle: TerminalHandle | null = null;
    let gone = false;
    const early: Buffer[] = [];
    channel.on('data', (data: Buffer) => {
      for (let at = 0; at < data.length; at += MAX_INPUT_CHUNK) {
        const frame = Buffer.concat([Buffer.from([TERMINAL_DATA]), data.subarray(at, at + MAX_INPUT_CHUNK)]);
        if (handle) handle.input(frame);
        else early.push(frame);
      }
    });
    channel.on('close', () => {
      gone = true;
      handle?.hangUp();
    });
    try {
      await this.requireOpenAccount(caller);
      handle = await this.terminals.openClient(caller.userId, caller.dockId, clampSize(String(size.cols), 80), clampSize(String(size.rows), 24), client);
    } catch (err) {
      closed = true;
      if (!gone) fail(channel, errorText(err));
      return null;
    }
    if (gone) {
      handle.hangUp();
      return null;
    }
    this.logger.log(`SSH shell for user ${caller.userId} on dock ${caller.dockId}`);
    for (const frame of early.splice(0)) handle.input(frame);
    return handle;
  }

  /** Re-checks closure per session so connections opened before a close cannot keep working. */
  private async requireOpenAccount(caller: Caller): Promise<void> {
    if ((await this.closures.guardCheck(caller.userId)) !== 'ok') throw new AccountClosedException();
  }

  private async exec(channel: ServerChannel, caller: Caller, command: string): Promise<void> {
    if (/^\s*scp(\s|$)/.test(command)) return fail(channel, UNSUPPORTED_FILE_TRANSFER);
    this.logger.log(`SSH exec for user ${caller.userId} on dock ${caller.dockId}`);
    try {
      await this.requireOpenAccount(caller);
      const result = await this.execs.exec(caller.userId, caller.dockId, { command, timeoutSeconds: this.execs.timeoutCeiling() });
      channel.write(result.stdout);
      channel.stderr.write(result.stderr);
      if (result.truncated) channel.stderr.write('\n[output truncated to 1 MiB per stream]\n');
      channel.exit(result.exitCode);
      channel.end();
    } catch (err) {
      fail(channel, errorText(err), err instanceof ExecTimeoutException ? 124 : 1);
    }
  }
}
