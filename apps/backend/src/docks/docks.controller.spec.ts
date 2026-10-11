import { DocksController } from './docks.controller';
import { vi, type Mock } from 'vitest';

describe('DocksController', () => {
  let docks: {
    create: Mock;
    list: Mock;
    getById: Mock;
    update: Mock;
    remove: Mock;
    stop: Mock;
    resume: Mock;
    branch: Mock;
  };
  let execs: { exec: Mock };
  let ports: { list: Mock; expose: Mock; remove: Mock; hostnameExposed: Mock };
  let portAccess: { authorize: Mock; access: Mock };
  let controller: DocksController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };

  beforeEach(() => {
    docks = {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      stop: vi.fn(),
      resume: vi.fn(),
      branch: vi.fn(),
    };
    execs = { exec: vi.fn() };
    ports = { list: vi.fn(), expose: vi.fn(), remove: vi.fn(), hostnameExposed: vi.fn() };
    portAccess = { authorize: vi.fn(), access: vi.fn() };
    controller = new DocksController(docks as never, execs as never, {} as never, ports as never, portAccess as never);
  });

  it('creates scoped to the user with the idempotency key', async () => {
    docks.create.mockResolvedValue({ id: 'd1', runtime: 'microvm' });
    await expect(controller.create(user, { workspaceId: 'ws' } as never, 'key-1')).resolves.toEqual({ id: 'd1', runtime: 'microvm', persistentPaths: ['/'] });
    expect(docks.create).toHaveBeenCalledWith('u1', { workspaceId: 'ws' }, 'key-1');
  });

  it('never returns env values or the llm token hash from any dock response', async () => {
    const secretRow = { id: 'd1', runtime: 'microvm', env: { K: 'secret-value' }, llmTokenHash: 'hash-value' };
    docks.create.mockResolvedValue(secretRow);
    docks.list.mockResolvedValue([secretRow]);
    docks.getById.mockResolvedValue(secretRow);
    docks.update.mockResolvedValue(secretRow);
    docks.branch.mockResolvedValue(secretRow);
    const out = [
      await controller.create(user, { workspaceId: 'ws' } as never),
      await controller.list(user, {}),
      await controller.getById(user, 'd1'),
      await controller.update(user, 'd1', {}),
      await controller.branch(user, 'd1', {}),
    ];
    expect(JSON.stringify(out)).not.toMatch(/secret-value|hash-value|llmTokenHash/);
  });

  it('lists with filter and all flag', async () => {
    docks.list.mockResolvedValue([]);
    await expect(controller.list(user, { filter: 'sr', all: true })).resolves.toEqual([]);
    expect(docks.list).toHaveBeenCalledWith('u1', 'sr', true);
  });

  it('passes the confirm header through on delete', async () => {
    docks.remove.mockResolvedValue({ operation: { id: 'op_1' } });
    await expect(controller.remove(user, 'd1', 'd1')).resolves.toEqual({ operation: { id: 'op_1' } });
    expect(docks.remove).toHaveBeenCalledWith('u1', 'd1', 'd1');
  });

  it('delegates stop, resume, and branch with bodies', async () => {
    docks.stop.mockResolvedValue({ state: 'archiving' });
    docks.resume.mockResolvedValue({ state: 'ready' });
    docks.branch.mockResolvedValue({ id: 'd2', runtime: 'gvisor' });
    await controller.stop(user, 'd1', { force: true });
    await controller.resume(user, 'd1', { cpus: 4 } as never);
    await controller.branch(user, 'd1', { ttlSeconds: 600 }, 'key-2');
    expect(docks.stop).toHaveBeenCalledWith('u1', 'd1', { force: true });
    expect(docks.resume).toHaveBeenCalledWith('u1', 'd1', { cpus: 4 });
    expect(docks.branch).toHaveBeenCalledWith('u1', 'd1', { ttlSeconds: 600 }, 'key-2');
  });

  it('reports persistent paths by runtime on reads and branches', async () => {
    docks.getById.mockResolvedValue({ id: 'd1', runtime: 'gvisor' });
    docks.list.mockResolvedValue([{ id: 'd1', runtime: 'microvm' }, { id: 'd2', runtime: 'gvisor' }]);
    await expect(controller.getById(user, 'd1')).resolves.toMatchObject({ runtime: 'gvisor', persistentPaths: ['/home/user/work'] });
    const listed = await controller.list(user, {});
    expect(listed.map((d) => d.persistentPaths)).toEqual([['/'], ['/home/user/work']]);
  });

  it('delegates exec with the body and idempotency key', async () => {
    execs.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false });
    await expect(controller.exec(user, 'd1', { command: 'ls' }, 'key-3')).resolves.toMatchObject({ exitCode: 0 });
    expect(execs.exec).toHaveBeenCalledWith('u1', 'd1', { command: 'ls' }, 'key-3');
  });

  it('delegates port listing, exposure, and removal', async () => {
    await controller.listPorts(user, 'd1');
    await controller.exposePort(user, 'd1', { port: 3000 });
    await controller.exposePort(user, 'd1', { port: 3001, visibility: 'public' });
    await controller.removePort(user, 'd1', 3000);
    expect(ports.list).toHaveBeenCalledWith('u1', 'd1');
    expect(ports.expose).toHaveBeenCalledWith('u1', 'd1', 3000, undefined);
    expect(ports.expose).toHaveBeenCalledWith('u1', 'd1', 3001, 'public');
    expect(ports.remove).toHaveBeenCalledWith('u1', 'd1', 3000);
  });

  function fakeRes() {
    const res = { headers: {} as Record<string, string>, code: 0, location: '', ended: false } as any;
    res.setHeader = (name: string, value: string) => (res.headers[name] = value);
    res.status = (code: number) => ((res.code = code), res);
    res.end = () => (res.ended = true);
    res.redirect = (code: number, location: string) => ((res.code = code), (res.location = location));
    return res;
  }

  it('maps the port access decision onto the edge response', async () => {
    const call = (result: unknown) => {
      portAccess.authorize.mockResolvedValueOnce(result);
      const res = fakeRes();
      return controller.portAuth('x.ports.dev', '/p', 'c=1', 'Bearer k', 'text/html', res).then(() => res);
    };
    const ok = await call({ status: 200, headers: { 'X-Dock-Port-Auth': 'proof' } });
    expect(ok).toMatchObject({ code: 200, ended: true, headers: { 'X-Dock-Port-Auth': 'proof', 'Cache-Control': 'no-store' } });
    const redirect = await call({ status: 302, location: 'https://api/login', setCookie: 'a=b; HttpOnly' });
    expect(redirect).toMatchObject({ code: 302, location: 'https://api/login', headers: { 'Set-Cookie': 'a=b; HttpOnly' } });
    portAccess.authorize.mockResolvedValueOnce({ status: 401 });
    await expect(controller.portAuth('x', '/', undefined, undefined, undefined, fakeRes())).rejects.toMatchObject({ status: 401 });
    expect(portAccess.authorize).toHaveBeenLastCalledWith({ host: 'x', uri: '/', cookie: undefined, authorization: undefined, wantsHtml: false });
    portAccess.access.mockResolvedValueOnce({ status: 404 });
    await expect(controller.portAccessLanding('x', '/', undefined, fakeRes())).rejects.toMatchObject({ status: 404 });
  });

  it('answers the edge TLS check only for exposed hostnames', async () => {
    ports.hostnameExposed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(controller.portTlsCheck('3000-abc.ports.x.dev')).resolves.toEqual({ exposed: true });
    await expect(controller.portTlsCheck('nope.ports.x.dev')).rejects.toMatchObject({ status: 404 });
    await expect(controller.portTlsCheck(undefined)).rejects.toMatchObject({ status: 404 });
  });
});
