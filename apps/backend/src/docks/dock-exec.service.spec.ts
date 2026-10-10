import { HttpException, Logger } from '@nestjs/common';
import { vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DockletException } from '../runtime/docklet.client';
import { CommandFailedException, CommandTimeoutException } from '../fleet/host-command-queue';
import { FakeComputeProvider } from './compute.provider';
import { DockNotFoundException } from './dock-errors';
import { EnvironmentSecretsAdminOnlyException } from '../environments/environments.service';
import { DockExecService, EXEC_MAX_OUTPUT_BYTES } from './dock-exec.service';
import { ExecDockDto } from './dto/exec-dock.dto';

describe('DockExecService', () => {
  const dockId = '33333333-3333-4333-8333-333333333333';
  let db: any;
  let docks: any;
  let provider: FakeComputeProvider;
  let limits: any;
  let redis: any;
  let config: any;
  let service: DockExecService;

  const dock = (overrides: Record<string, unknown> = {}) => ({ id: dockId, state: 'ready', hostId: 'h1', billingPausedAt: null, ...overrides });
  const runRows = (rows: unknown[]) => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });

  async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected rejection');
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    db = { select: vi.fn().mockReturnValue(runRows([])) };
    docks = { loadReadableDock: vi.fn().mockResolvedValue({ dock: dock(), orgId: 'o1' }) };
    provider = new FakeComputeProvider();
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    redis = { incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1), decr: vi.fn().mockResolvedValue(0) };
    config = { get: vi.fn().mockReturnValue(undefined) };
    service = new DockExecService(db as never, docks as never, provider, limits as never, redis as never, config as never);
  });

  it('runs the command in the work dir with defaults and returns bounded output', async () => {
    const spy = vi.spyOn(provider, 'exec').mockResolvedValue({ exitCode: 0, stdout: 'hi\n', stderr: '', truncated: false, timedOut: false });
    const res = await service.exec('u1', dockId, { command: 'echo hi' });
    expect(res).toMatchObject({ exitCode: 0, stdout: 'hi\n', stderr: '', truncated: false });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(docks.loadReadableDock).toHaveBeenCalledWith('u1', dockId);
    const [, request] = spy.mock.calls[0];
    expect(request.script).toBe("cd -- '/home/user/work' || exit 1\necho hi");
    expect(request.timeoutSeconds).toBe(60);
    expect(request.env).toBeUndefined();
    expect(request.idempotencyToken).toMatch(new RegExp(`^exec:${dockId}:`));
    expect(redis.decr).toHaveBeenCalledWith(`exec:inflight:${dockId}`);
  });

  it('quotes a custom cwd and passes env and the Idempotency-Key through as a stable token', async () => {
    const spy = vi.spyOn(provider, 'exec');
    await service.exec('u1', dockId, { command: 'pwd', cwd: "/tmp/it's", env: { API_TOKEN: 's3cret' }, timeoutSeconds: 5 }, 'key-1');
    await service.exec('u1', dockId, { command: 'pwd', cwd: "/tmp/it's", env: { API_TOKEN: 's3cret' }, timeoutSeconds: 5 }, 'key-1');
    const [first, second] = spy.mock.calls.map(([, request]) => request);
    expect(first.script).toBe("cd -- '/tmp/it'\\''s' || exit 1\npwd");
    expect(first.env).toEqual({ API_TOKEN: 's3cret' });
    expect(first.timeoutSeconds).toBe(5);
    expect(first.idempotencyToken).toBe(second.idempotencyToken);
    expect(first.idempotencyToken).not.toContain('key-1');
  });

  it('refuses exec, terminal and SSH access to a dock holding admins-only secrets', async () => {
    docks.loadReadableDock.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    const err = await catchErr(service.exec('u1', dockId, { command: 'cat ~/.dock/env.sh' }));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    docks.loadReadableDock.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    expect((await catchErr(service.loadExecutableDock('u1', dockId))).status).toBe(403);
  });

  it('hides foreign or missing docks as 404', async () => {
    docks.loadReadableDock.mockRejectedValueOnce(new DockNotFoundException());
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'dock_not_found' });
  });

  it.each(['archived', 'archiving', 'provisioning', 'error'])('refuses a %s dock with dock_not_running', async (state) => {
    docks.loadReadableDock.mockResolvedValueOnce({ dock: dock({ state }), orgId: 'o1' });
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'dock_not_running' });
  });

  it('refuses a running dock whose billing is paused', async () => {
    docks.loadReadableDock.mockResolvedValueOnce({ dock: dock({ billingPausedAt: new Date() }), orgId: 'o1' });
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err.body).toMatchObject({ code: 'dock_not_running' });
  });

  it('refuses run-owned docks, which carry run credentials', async () => {
    db.select.mockReturnValueOnce(runRows([{ id: 'run-1' }]));
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'exec_unavailable' });
  });

  it.each([
    [new DockletException('exec_unavailable', 'fast runtime d not found'), 'exec_unavailable', 409],
    [new CommandFailedException('host_error', 'exec_unavailable: fast runtime abc not found'), 'exec_unavailable', 409],
    [new CommandFailedException('result_not_retained', 'already executed, result not retained'), 'exec_result_expired', 409],
    [new CommandFailedException('host_busy', 'too many'), 'exec_busy', 503],
    [new CommandTimeoutException('fast-run.exec'), 'exec_timeout', 504],
    [new Error('socket hang up'), 'exec_failed', 503],
  ])('maps host failure %#', async (failure, code, status) => {
    vi.spyOn(provider, 'exec').mockRejectedValueOnce(failure);
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err).toMatchObject({ status, body: { code } });
    expect(redis.decr).toHaveBeenCalled();
  });

  it('maps a guest-side timeout to 504 exec_timeout', async () => {
    vi.spyOn(provider, 'exec').mockResolvedValueOnce({ exitCode: 124, stdout: '', stderr: '', truncated: false, timedOut: true });
    const err = await catchErr(service.exec('u1', dockId, { command: 'sleep 99', timeoutSeconds: 2 }));
    expect(err).toMatchObject({ status: 504, body: { code: 'exec_timeout' } });
  });

  it('keeps a quick exit 124 as a normal result', async () => {
    vi.spyOn(provider, 'exec').mockResolvedValueOnce({ exitCode: 124, stdout: '', stderr: '', truncated: false, timedOut: false });
    await expect(service.exec('u1', dockId, { command: 'exit 124' })).resolves.toMatchObject({ exitCode: 124 });
  });

  it('clips each stream to 1 MiB and flags truncation', async () => {
    vi.spyOn(provider, 'exec').mockResolvedValueOnce({ exitCode: 0, stdout: 'x'.repeat(EXEC_MAX_OUTPUT_BYTES + 5), stderr: 'e', truncated: false, timedOut: false });
    const res = await service.exec('u1', dockId, { command: 'yes' });
    expect(Buffer.byteLength(res.stdout)).toBe(EXEC_MAX_OUTPUT_BYTES);
    expect(res.stderr).toBe('e');
    expect(res.truncated).toBe(true);
  });

  it('passes through truncation reported by the guest', async () => {
    vi.spyOn(provider, 'exec').mockResolvedValueOnce({ exitCode: 0, stdout: 'x', stderr: '', truncated: true, timedOut: false });
    await expect(service.exec('u1', dockId, { command: 'yes' })).resolves.toMatchObject({ truncated: true });
  });

  it('caps timeoutSeconds at the fleet exec budget minus dispatch slack', async () => {
    expect(service.timeoutCeiling()).toBe(240);
    const err = await catchErr(service.exec('u1', dockId, { command: 'true', timeoutSeconds: 241 }));
    expect(err).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    config.get.mockImplementation((key: string) => (key === 'FLEET_TIMEOUT_FAST_RUN_EXEC_MS' ? '900000' : undefined));
    expect(service.timeoutCeiling()).toBe(600);
  });

  it.each([
    [{ 'BAD-KEY': 'v' }],
    [{ DOCK_ID: 'v' }],
    [{ A: 1 }],
    [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']))],
    [{ BIG: 'x'.repeat(40000) }],
  ])('rejects invalid env %#', async (env) => {
    const err = await catchErr(service.exec('u1', dockId, { command: 'true', env: env as never }));
    expect(err).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    expect(docks.loadReadableDock).not.toHaveBeenCalled();
  });

  it('rejects commands over 64KB of UTF-8', async () => {
    const err = await catchErr(service.exec('u1', dockId, { command: 'é'.repeat(40000) }));
    expect(err.body).toMatchObject({ code: 'validation_error' });
  });

  it('rate limits per dock and per caller', async () => {
    limits.hit.mockResolvedValueOnce({ allowed: false, count: 121 });
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(limits.hit).toHaveBeenCalledWith(`rl:exec:dock:${dockId}`, 120, 60);
  });

  it('bounds concurrent commands per dock and releases the refused slot', async () => {
    redis.incr.mockResolvedValueOnce(5);
    const spy = vi.spyOn(provider, 'exec');
    const err = await catchErr(service.exec('u1', dockId, { command: 'true' }));
    expect(err).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(redis.decr).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never logs the command or env values', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(provider, 'exec').mockRejectedValueOnce(new Error('guest said TOPSECRET_VALUE'));
    await catchErr(service.exec('u1', dockId, { command: 'echo SECRET_COMMAND', env: { TOKEN: 'TOPSECRET_VALUE' } }));
    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toContain('TOPSECRET_VALUE');
    expect(logged).not.toContain('SECRET_COMMAND');
  });
});

describe('ExecDockDto', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(ExecDockDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

  it('accepts a minimal and a full body', async () => {
    await expect(errorsFor({ command: 'ls' })).resolves.toEqual([]);
    await expect(errorsFor({ command: 'ls', timeoutSeconds: 600, env: { A: 'b' }, cwd: '/srv/app' })).resolves.toEqual([]);
  });

  it.each([
    [{}, 'command'],
    [{ command: '' }, 'command'],
    [{ command: 'x'.repeat(65537) }, 'command'],
    [{ command: 'ls', timeoutSeconds: 0 }, 'timeoutSeconds'],
    [{ command: 'ls', timeoutSeconds: 601 }, 'timeoutSeconds'],
    [{ command: 'ls', timeoutSeconds: 1.5 }, 'timeoutSeconds'],
    [{ command: 'ls', env: 'A=b' }, 'env'],
    [{ command: 'ls', cwd: 'relative' }, 'cwd'],
    [{ command: 'ls', cwd: '/a\nb' }, 'cwd'],
    [{ command: 'ls', execAgent: true }, 'execAgent'],
  ])('rejects %j', async (body, property) => {
    await expect(errorsFor(body)).resolves.toContain(property);
  });
});
