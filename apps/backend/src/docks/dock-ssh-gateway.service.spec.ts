import { Client, type ClientChannel } from 'ssh2';
import { ed25519KeyPair } from '../ssh-keys/__fixtures__/ed25519-key-pair';
import { vi } from 'vitest';
import { DockNotFoundException, DockNotRunningException } from './dock-errors';
import { EnvironmentSecretsAdminOnlyException } from '../environments/environments.service';
import { DockSshGatewayService } from './dock-ssh-gateway.service';
import { TERMINAL_CLOSE, TERMINAL_DATA, TERMINAL_EXIT, TERMINAL_RESIZE, type TerminalClient } from './dock-terminal.service';

const dockId = '33333333-3333-4333-8333-333333333333';
const userKey = ed25519KeyPair(1);
const strangerKey = ed25519KeyPair(2);

function canonical(pub: string): string {
  return pub.split(' ').slice(0, 2).join(' ');
}

describe('DockSshGatewayService', () => {
  let keys: any;
  let docks: any;
  let execs: any;
  let terminals: any;
  let limits: any;
  let closures: any;
  let registry: any;
  let gateway: DockSshGatewayService;
  let port: number;
  let opened: Array<{ args: unknown[]; client: TerminalClient; inputs: Buffer[]; hungUp: boolean }>;
  const clients: Client[] = [];

  beforeEach(async () => {
    opened = [];
    keys = {
      findByBlob: vi.fn(async (blob: Buffer) =>
        blob.equals(Buffer.from(userKey.public.split(' ')[1], 'base64')) ? [{ id: 'k1', userId: 'u1', publicKey: canonical(userKey.public) }] : [],
      ),
      touch: vi.fn().mockResolvedValue(undefined),
    };
    docks = {
      loadReadableDock: vi.fn(async (userId: string, id: string) => {
        if (userId !== 'u1' || id !== dockId) throw new DockNotFoundException();
        return { dock: { id }, orgId: 'o1' };
      }),
    };
    execs = {
      exec: vi.fn().mockResolvedValue({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', durationMs: 5, truncated: false }),
      timeoutCeiling: vi.fn().mockReturnValue(600),
    };
    terminals = {
      openClient: vi.fn(async (...args: unknown[]) => {
        const entry = { args: args.slice(0, 4), client: args[4] as TerminalClient, inputs: [] as Buffer[], hungUp: false };
        opened.push(entry);
        return { input: (frame: Buffer) => entry.inputs.push(frame), hangUp: () => (entry.hungUp = true) };
      }),
    };
    registry = { register: vi.fn().mockReturnValue(() => undefined) };
    closures = { guardCheck: vi.fn().mockResolvedValue('ok') };
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    const config = { get: (key: string) => ({ SSH_GATEWAY_PORT: 0, BETTER_AUTH_SECRET: 'x'.repeat(40) })[key] };
    gateway = new DockSshGatewayService(keys, docks, execs, terminals, limits, config as never, closures as never, registry as never);
    port = (await gateway.listen('127.0.0.1')) as number;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.end();
    gateway.onModuleDestroy();
  });

  function connect(username = dockId, privateKey = userKey.private): Promise<Client> {
    const client = new Client();
    clients.push(client);
    return new Promise((resolve, reject) => {
      client.once('ready', () => resolve(client));
      client.once('error', reject);
      client.connect({ host: '127.0.0.1', port, username, privateKey });
    });
  }

  function run(client: Client, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        stream.on('close', (code: number) => resolve({ stdout, stderr, code }));
      });
    });
  }

  /** Exit and stderr are captured before resolving: the server's failure frames can arrive in the same read as the channel open. */
  type CapturedShell = ClientChannel & { exited: Promise<number>; errText: () => string };
  function shell(client: Client): Promise<CapturedShell> {
    return new Promise((resolve, reject) =>
      client.shell({ cols: 132, rows: 43, term: 'xterm' }, (err, stream) => {
        if (err) return reject(err);
        let text = '';
        stream.stderr.on('data', (d: Buffer) => (text += d.toString()));
        const exited = new Promise<number>((done) => stream.on('exit', (c: number) => done(c)));
        resolve(Object.assign(stream, { exited, errText: () => text }));
      }),
    );
  }

  it('stays off without SSH_GATEWAY_PORT', async () => {
    const off = new DockSshGatewayService(keys, docks, execs, terminals, limits, { get: () => undefined } as never, closures as never, registry as never);
    await expect(off.listen()).resolves.toBeNull();
  });

  it('accepts a registered key for a dock its owner can see and records the use', async () => {
    await connect();
    expect(docks.loadReadableDock).toHaveBeenCalledWith('u1', dockId);
    await vi.waitFor(() => expect(keys.touch).toHaveBeenCalledWith('k1'));
    expect(limits.hit).toHaveBeenCalledWith(expect.stringMatching(/^rl:ssh:auth:/), 60, 60);
  });

  it('refuses unknown keys, foreign docks, passwords, and rate-limited sources', async () => {
    await expect(connect(dockId, strangerKey.private)).rejects.toThrow(/authentication methods failed/);
    await expect(connect('44444444-4444-4444-8444-444444444444')).rejects.toThrow(/authentication methods failed/);
    const client = new Client();
    clients.push(client);
    await expect(
      new Promise((resolve, reject) => {
        client.once('ready', resolve).once('error', reject);
        client.connect({ host: '127.0.0.1', port, username: dockId, password: 'hunter2' });
      }),
    ).rejects.toThrow(/authentication methods failed/);
    limits.hit.mockResolvedValue({ allowed: false, count: 61 });
    await expect(connect()).rejects.toThrow(/authentication methods failed/);
  });

  it('refuses a key whose owner may not read a dock holding admins-only secrets', async () => {
    docks.loadReadableDock.mockRejectedValue(new EnvironmentSecretsAdminOnlyException());
    await expect(connect()).rejects.toThrow(/authentication methods failed/);
    expect(docks.loadReadableDock).toHaveBeenCalledWith('u1', dockId);
  });

  it('refuses keys whose account is closed or erased', async () => {
    for (const state of ['closed', 'erased']) {
      closures.guardCheck.mockResolvedValue(state);
      await expect(connect()).rejects.toThrow(/authentication methods failed/);
    }
    expect(closures.guardCheck).toHaveBeenCalledWith('u1');
    expect(docks.loadReadableDock).not.toHaveBeenCalled();
  });

  it('refuses new sessions on a connection that outlived the account', async () => {
    const client = await connect();
    closures.guardCheck.mockResolvedValue('closed');
    const exec = await run(client, 'true');
    expect(exec).toMatchObject({ code: 1, stderr: expect.stringMatching(/closed/) });
    expect(execs.exec).not.toHaveBeenCalled();
  });

  it('refuses a shell on a connection that outlived the account', async () => {
    const client = await connect();
    closures.guardCheck.mockResolvedValue('closed');
    const stream = await shell(client);
    const code = await stream.exited;
    expect(code).toBe(1);
    expect(stream.errText()).toMatch(/closed/);
    expect(terminals.openClient).not.toHaveBeenCalled();
  });

  it('runs commands through the exec API and returns output and exit status', async () => {
    const client = await connect();
    await expect(run(client, 'uname -a')).resolves.toEqual({ stdout: 'out\n', stderr: 'err\n', code: 3 });
    expect(execs.exec).toHaveBeenCalledWith('u1', dockId, { command: 'uname -a', timeoutSeconds: 600 });
  });

  it('reports exec errors on stderr', async () => {
    execs.exec.mockRejectedValue(new DockNotRunningException('stopped'));
    const client = await connect();
    const result = await run(client, 'true');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/stopped/);
  });

  it('refuses scp and sftp with a pointer to the exec API', async () => {
    const client = await connect();
    const result = await run(client, 'scp -t .');
    expect(result).toMatchObject({ code: 1, stderr: expect.stringMatching(/SCP and SFTP are not available/) });
    expect(execs.exec).not.toHaveBeenCalled();
    await expect(new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))).rejects.toThrow();
  });

  it('relays an interactive shell over the terminal relay', async () => {
    const client = await connect();
    const stream = await shell(client);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const [entry] = opened;
    expect(entry.args).toEqual(['u1', dockId, 132, 43]);
    stream.write('ls\n');
    await vi.waitFor(() => expect(entry.inputs.map((f) => f.toString('latin1'))).toContain(`${String.fromCharCode(TERMINAL_DATA)}ls\n`));
    stream.setWindow(50, 200, 0, 0);
    await vi.waitFor(() => expect(entry.inputs.some((f) => f[0] === TERMINAL_RESIZE)).toBe(true));
    const resize = entry.inputs.find((f) => f[0] === TERMINAL_RESIZE) as Buffer;
    expect([resize.readUInt16BE(1), resize.readUInt16BE(3)]).toEqual([200, 50]);
    let output = '';
    stream.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number>((resolve) => stream.on('exit', (code: number) => resolve(code)));
    entry.client.send(Buffer.concat([Buffer.from([TERMINAL_DATA]), Buffer.from('file.txt\r\n')]), () => undefined);
    const exit = Buffer.alloc(5);
    exit[0] = TERMINAL_EXIT;
    exit.writeInt32BE(7, 1);
    entry.client.send(exit, () => undefined);
    entry.client.close(TERMINAL_CLOSE.exited, 'Shell exited');
    await expect(exited).resolves.toBe(7);
    expect(output).toBe('file.txt\r\n');
  });

  it('hangs the terminal up when the SSH channel closes', async () => {
    const client = await connect();
    const stream = await shell(client);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    stream.close();
    await vi.waitFor(() => expect(opened[0].hungUp).toBe(true));
  });

  it('shows why a shell could not open', async () => {
    terminals.openClient.mockRejectedValue(new DockNotRunningException('stopped'));
    const client = await connect();
    const stream = await shell(client);
    const code = await stream.exited;
    expect(code).toBe(1);
    expect(stream.errText()).toMatch(/stopped/);
  });

  it('refuses port forwarding', async () => {
    const client = await connect();
    await expect(new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, '127.0.0.1', 80, (err, ch) => (err ? reject(err) : resolve(ch))))).rejects.toThrow();
    await expect(new Promise((resolve, reject) => client.forwardIn('127.0.0.1', 0, (err) => (err ? reject(err) : resolve(null))))).rejects.toThrow();
  });
});
