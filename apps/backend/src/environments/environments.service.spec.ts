import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { EnvironmentsService } from './environments.service';
import { sealValue } from './secrets';
import { vi, type Mock } from 'vitest';

const KEY = Buffer.from('a'.repeat(64), 'hex');
const seal = (plain: string) => sealValue(KEY, plain);

const orgId = '11111111-1111-4111-8111-111111111111';
const envId = '22222222-2222-4222-8222-222222222222';
const callerId = '33333333-3333-4333-8333-333333333333';

const envRow = (overrides: Record<string, unknown> = {}) => ({
  id: envId,
  organizationId: orgId,
  name: 'base',
  isDefault: true,
  currentVersion: 1,
  secretsAccess: 'members',
  deletedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
});

const versionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'v-row',
  environmentId: envId,
  version: 1,
  safeForThirdParties: false,
  passGithub: true,
  passSecrets: true,
  passDockCredentials: true,
  passAgentsCredentials: true,
  repos: [],
  envVars: {},
  secretFiles: [],
  createdAt: new Date('2026-01-01'),
  ...overrides,
});

describe('EnvironmentsService', () => {
  let db: any;
  let orgs: any;
  let ops: any;
  let creds: { varsFor: Mock };
  let service: EnvironmentsService;

  const selectQ = (rows: any[]) => {
    const p = Promise.resolve(rows);
    const chain: any = { limit: () => p, orderBy: () => chain, then: p.then.bind(p) };
    return { from: () => ({ where: () => chain }) };
  };
  const insertQ = (rows: any[]) => ({ values: () => ({ returning: () => Promise.resolve(rows) }) });
  const updateQ = (rows: any[]) => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }) });
  async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected rejection');
  }

  /** Queues latestVersion + connection reads (workspaces, installations) with the env already in hand. */
  function queueTail(version: unknown = versionRow(), installations: unknown[] = []) {
    db.select
      .mockReturnValueOnce(selectQ([version]))
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }]))
      .mockReturnValueOnce(selectQ(installations));
  }

  /** Queues the four reads viewOf performs: env, version, workspaces, installations. */
  function queueView(env: unknown = envRow(), version: unknown = versionRow(), installations: unknown[] = []) {
    db.select.mockReturnValueOnce(selectQ([env]));
    queueTail(version, installations);
  }

  beforeEach(() => {
    db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: () => Promise.resolve([]) }),
      transaction: vi.fn(async (cb: any) => cb(db)),
    };
    vi.clearAllMocks();
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    ops = {
      create: vi.fn().mockResolvedValue({ id: 'op_1', status: 'pending' }),
      complete: vi.fn().mockResolvedValue({ id: 'op_1', status: 'completed' }),
    };
    const config = { getOrThrow: vi.fn().mockReturnValue('a'.repeat(64)), get: vi.fn().mockReturnValue('configured') };
    const credsMock = { varsFor: vi.fn().mockResolvedValue({ vars: {}, providers: [] }) };
    creds = credsMock;
    service = new EnvironmentsService(db as never, orgs as never, ops as never, config as never, creds as never);
  });

  it('provisions base lazily on first listing', async () => {
    db.select.mockReturnValueOnce(selectQ([])); // liveEnvironments: empty
    db.insert.mockReturnValueOnce(insertQ([envRow()])); // ensureBase env
    db.insert.mockReturnValueOnce(insertQ([versionRow()])); // ensureBase v1
    db.select.mockReturnValueOnce(selectQ([envRow()])); // liveEnvironments: base
    queueTail();
  });

  it('hides foreign environments as environment_not_found', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const err = await catchErr(service.getByRef(callerId, envId));
    expect(err).toMatchObject({ status: 404, body: { code: 'environment_not_found' } });
  });

  it('rejects member writes with forbidden', async () => {
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
    const err = await catchErr(service.create(callerId, orgId, 'staging'));
    expect(err.body).toMatchObject({ code: 'forbidden' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects duplicate names and invalid names', async () => {
    db.insert.mockImplementationOnce(() => {
      throw { code: '23505' };
    });
    const taken = await catchErr(service.create(callerId, orgId, 'staging'));
    expect(taken).toMatchObject({ status: 409, body: { code: 'environment_name_taken' } });
    const invalid = await catchErr(service.create(callerId, orgId, 'Bad Name!'));
    expect(invalid).toMatchObject({ status: 400, body: { code: 'validation_error' } });
  });

  it('bumps the version on posture saves but not on rename', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow()])); // bump latest
    db.insert.mockReturnValueOnce(insertQ([versionRow({ version: 2, passSecrets: false })]));
    db.update.mockReturnValueOnce(updateQ([envRow({ currentVersion: 2 })])); // pointer
    queueView(envRow({ currentVersion: 2 }), versionRow({ version: 2, passSecrets: false }));
    const patched = await service.update(callerId, envId, undefined, { passSecrets: false });
    expect(patched.currentVersion).toBe(2);
    expect(patched.passSecrets).toBe(false);

    vi.clearAllMocks();
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.update.mockReturnValueOnce(updateQ([envRow({ name: 'prod' })])); // rename
    db.select.mockReturnValueOnce(selectQ([{ id: 'ws-1' }])); // workspaces for dock refs
    const dockSets: unknown[] = [];
    db.update.mockReturnValueOnce({ set: (v: unknown) => { dockSets.push(v); return { where: () => Promise.resolve([]) }; } });
    queueView(envRow({ name: 'prod' }));
    const renamed = await service.update(callerId, envId, undefined, { name: 'prod' });
    expect(renamed.name).toBe('prod');
    expect(dockSets).toEqual([expect.objectContaining({ environment: 'prod' })]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses to delete the sole default', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([envRow()])); // siblings: only itself
    const err = await catchErr(service.remove(callerId, envId));
    expect(err).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('passes the default to the oldest sibling on delete', async () => {
    const older = envRow({ id: 'older-id', name: 'prod', isDefault: false, createdAt: new Date('2025-01-01') });
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([envRow(), older])); // siblings
    db.update.mockReturnValue(updateQ([envRow()])); // soft delete + promote
    await expect(service.remove(callerId, envId)).resolves.toEqual({ deleted: true });
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it('counts docks per version newest-first', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 2 }), versionRow({ version: 1 })]));
    db.select.mockReturnValueOnce(selectQ([{ id: 'ws-1' }])); // workspaces
    db.select.mockReturnValueOnce(selectQ([{ pin: 'v2' }, { pin: 'v2' }, { pin: 'v1' }, { pin: null }]));
    await expect(service.listVersions(callerId, envId)).resolves.toEqual([
      { version: 2, createdAt: expect.any(Date), dockCount: 2 },
      { version: 1, createdAt: expect.any(Date), dockCount: 1 },
    ]);
  });

  it('refuses upgrade ids pinned to another environment', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3 })])); // latest
    db.select.mockReturnValueOnce(selectQ([{ id: 'ws-1' }])); // workspaces
    db.select.mockReturnValueOnce(selectQ([{ id: '44444444-4444-4444-8444-444444444444', workspaceId: 'ws-1', environment: 'web', envVersionPin: 'v1' }]));
    const err = await catchErr(service.upgrade(callerId, envId, undefined, ['44444444-4444-4444-8444-444444444444']));
    expect(err).toMatchObject({ status: 404, body: { code: 'dock_not_found' } });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses to unset the default without naming a new one', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    const err = await catchErr(service.update(callerId, envId, undefined, { isDefault: false }));
    expect(err).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('defaults new environments to admins-only secrets and honors explicit members', async () => {
    const seen: unknown[] = [];
    const ins = (rows: unknown[]) => ({ values: (v: unknown) => { seen.push(v); return { returning: () => Promise.resolve(rows) }; } });
    db.insert.mockReturnValueOnce(ins([envRow({ secretsAccess: 'admins' })])).mockReturnValueOnce(insertQ([versionRow()]));
    queueTail();
    await service.create(callerId, orgId, 'web');
    expect(seen[0]).toMatchObject({ secretsAccess: 'admins' });
    db.insert.mockReturnValueOnce(ins([envRow({ secretsAccess: 'members' })])).mockReturnValueOnce(insertQ([versionRow()]));
    queueTail();
    await service.create(callerId, orgId, 'web2', 'members');
    expect(seen[1]).toMatchObject({ secretsAccess: 'members' });
  });

  it('frees a deleted name before creating it again', async () => {
    db.insert.mockReturnValueOnce(insertQ([envRow({ name: 'web', isDefault: false })]));
    db.insert.mockReturnValueOnce(insertQ([versionRow()]));
    queueTail();
    const created = await service.create(callerId, orgId, 'web');
    expect(created.name).toBe('web');
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects repos whose folder is unusable or already taken', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    const dots = await catchErr(service.addRepo(callerId, envId, undefined, { provider: 'github', repositoryId: '1', fullName: 'acme/..' }));
    expect(dots).toMatchObject({ status: 400 });
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ repos: [{ id: 'r1', provider: 'github', repositoryId: '1', fullName: 'acme/web', baseBranch: null, setupScript: null }] })]));
    const clash = await catchErr(service.addRepo(callerId, envId, undefined, { provider: 'github', repositoryId: '2', fullName: 'other/web' }));
    expect(clash).toMatchObject({ status: 409 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('validates upgrade ids before changing anything', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3 })])); // latest
    db.select.mockReturnValueOnce(selectQ([{ id: 'ws-1' }])); // workspaces
    db.select.mockReturnValueOnce(selectQ([])); // unknown dock
    const err = await catchErr(service.upgrade(callerId, envId, undefined, ['99999999-9999-4999-8999-999999999999']));
    expect(err).toMatchObject({ status: 404, body: { code: 'dock_not_found' } });
    expect(db.update).not.toHaveBeenCalled();
    expect(ops.create).not.toHaveBeenCalled();
  });

  it('upgrade moves only older pins and completes the operation', async () => {
    const oldDock = { id: '44444444-4444-4444-8444-444444444444', workspaceId: 'ws-1', environment: 'base', envVersionPin: 'v1' };
    const currentDock = { id: '55555555-5555-5555-8555-555555555555', workspaceId: 'ws-1', environment: 'base', envVersionPin: 'v3' };
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3 })])); // latest
    db.select.mockReturnValueOnce(selectQ([{ id: 'ws-1' }])); // workspaces
    db.select.mockReturnValueOnce(selectQ([oldDock])); // d1
    db.select.mockReturnValueOnce(selectQ([currentDock])); // d2
    db.update.mockReturnValue(updateQ([{ ...oldDock, envVersionPin: 'v3' }]));
    const res = await service.upgrade(callerId, envId, undefined, [oldDock.id, currentDock.id]);
    expect(res).toEqual({ operation: { id: 'op_1', status: 'completed' }, moved: [oldDock.id], orgId });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('safe posture withholds everything except per-dock env', async () => {
    const version = versionRow({
      version: 3,
      safeForThirdParties: true,
      envVars: { STRIPE_KEY: seal('shared') },
      secretFiles: [{ path: 'backend/.env', size: 3, contents: seal('x=1') }],
      repos: [{ id: 'r1', provider: 'github', repositoryId: '1', fullName: 'o/r', baseBranch: 'main', setupScript: null }],
    });
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveVersion env
    db.select.mockReturnValueOnce(selectQ([version])); // latest
    const bundle = await service.resolveBundle(orgId, 'base', { perDockEnv: { OWN: '1' } });
    expect(bundle).toEqual({ version: 3, vars: { OWN: '1' }, files: [], repos: [], injectedProviders: [], passDockCredentials: false, passAgentsCredentials: false });
  });

  it('merges per-dock env over stored vars with per-dock winning', async () => {
    const version = versionRow({ envVars: { STRIPE_KEY: seal('shared'), OTHER: seal('kept') } });
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    db.select.mockReturnValueOnce(selectQ([version]));
    const bundle = await service.resolveBundle(orgId, 'base', { perDockEnv: { STRIPE_KEY: 'per-dock' } });
    expect(bundle.vars).toEqual({ STRIPE_KEY: 'per-dock', OTHER: 'kept' });
  });

  it('injects required vars for resolved agents with explicit keys winning', async () => {
    const version = versionRow({ envVars: { STRIPE_KEY: seal('shared') } });
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    db.select.mockReturnValueOnce(selectQ([version]));
    creds.varsFor.mockResolvedValueOnce({
      vars: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' },
      providers: ['openai', 'anthropic'],
    });
    const bundle = await service.resolveBundle(orgId, 'base', {
      agents: ['codex', 'opencode'],
      perDockEnv: { OPENAI_API_KEY: 'sk-dock' },
    });
    expect(creds.varsFor).toHaveBeenCalledWith(orgId, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY']);
    expect(bundle.vars).toEqual({ STRIPE_KEY: 'shared', OPENAI_API_KEY: 'sk-dock', ANTHROPIC_API_KEY: 'sk-a' });
    expect(bundle.injectedProviders).toEqual(['openai', 'anthropic']);
  });

  it('excludes keys for unselected agents and ignores unknown agents', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    db.select.mockReturnValueOnce(selectQ([versionRow()]));
    const bundle = await service.resolveBundle(orgId, 'base', { agents: ['codex', 'no-such-agent'] });
    expect(creds.varsFor).toHaveBeenCalledWith(orgId, ['OPENAI_API_KEY']);
    expect(bundle.injectedProviders).toEqual([]);
  });

  it('withholds platform keys under safe, noEnv, and agents-credentials-off postures', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    db.select.mockReturnValueOnce(selectQ([versionRow({ safeForThirdParties: true })]));
    const safe = await service.resolveBundle(orgId, 'base', { agents: ['codex'] });
    expect(safe.vars).toEqual({});
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    db.select.mockReturnValueOnce(selectQ([versionRow()]));
    const noEnv = await service.resolveBundle(orgId, 'base', { agents: ['codex'], noEnv: true });
    expect(noEnv.vars).toEqual({});
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    db.select.mockReturnValueOnce(selectQ([versionRow({ passAgentsCredentials: false })]));
    const off = await service.resolveBundle(orgId, 'base', { agents: ['codex'] });
    expect(off.vars).toEqual({});
    expect(creds.varsFor).not.toHaveBeenCalled();
    expect(off.injectedProviders).toEqual([]);
  });

  it('drops previously injected keys when resolving an upgraded withholding pin', async () => {
    creds.varsFor.mockResolvedValue({ vars: { OPENAI_API_KEY: 'sk-o' }, providers: ['openai'] });
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveVersion env
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3, passAgentsCredentials: false })])); // latest
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 2 })])); // pinned v2
    const before = await service.resolveBundle(orgId, 'base', { version: 2, agents: ['codex'] });
    expect(before.vars).toEqual({ OPENAI_API_KEY: 'sk-o' });
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveVersion env
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3, passAgentsCredentials: false })])); // latest
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3, passAgentsCredentials: false })])); // pinned v3
    const after = await service.resolveBundle(orgId, 'base', { version: 3, agents: ['codex'] });
    expect(after.vars).toEqual({});
    expect(after.injectedProviders).toEqual([]);
    expect(JSON.stringify(after.injectedProviders)).not.toContain('sk-o');
  });

  it('bulk replacement drops omitted entries', async () => {
    const seen: any[] = [];
    db.insert.mockImplementation(() => ({
      values: (v: any) => {
        seen.push(v);
        return { returning: async () => [versionRow({ version: 2 })] };
      },
    }));
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ envVars: { A: seal('1'), B: seal('2') } })])); // latest
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 2 })])); // bump latest
    db.update.mockReturnValueOnce(updateQ([envRow({ currentVersion: 2 })])); // pointer
    queueView(envRow({ currentVersion: 2 }), versionRow({ version: 2 }));
    await service.replaceSecrets(callerId, envId, undefined, { envContents: 'B=2\n' });
    const sealed = seen[seen.length - 1].envVars as Record<string, { data: string }>;
    expect(Object.keys(sealed)).toEqual(['B']);
  });

  it('granular set keeps the rest and reads stay masked', async () => {
    const seen: any[] = [];
    db.insert.mockImplementation(() => ({
      values: (v: any) => {
        seen.push(v);
        return { returning: async () => [versionRow({ version: 2 })] };
      },
    }));
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ envVars: { A: seal('shhh') } })])); // bump latest
    db.update.mockReturnValueOnce(updateQ([envRow({ currentVersion: 2 })])); // pointer
    queueView(envRow({ currentVersion: 2 }), versionRow({ version: 2, envVars: { A: seal('shhh'), B: seal('new') } }));
    const view = await service.setVar(callerId, envId, undefined, 'B', 'new');
    expect(view.varNames).toEqual(['A', 'B']);
    expect(JSON.stringify(view)).not.toContain('shhh');
    expect(Object.keys(seen[seen.length - 1].envVars).sort()).toEqual(['A', 'B']);
  });

  it('reveal returns plaintext to admins', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(
      selectQ([versionRow({ envVars: { A: seal('shhh') }, secretFiles: [{ path: 'backend/.env', size: 3, contents: seal('x=1') }] })]),
    );
    await expect(service.revealSecrets(callerId, envId)).resolves.toEqual({
      envContents: 'A=shhh\n',
      secretFiles: [{ path: 'backend/.env', size: 3, contents: 'x=1' }],
    });
  });

  it('rejects reserved keys and bad paths without storing', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef again
    const reserved = await catchErr(service.setVar(callerId, envId, undefined, 'DOCK_ID', 'evil'));
    expect(reserved).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    const absolute = await catchErr(service.setFile(callerId, envId, undefined, '/abs/path', 'x'));
    expect(absolute.body).toMatchObject({ code: 'validation_error' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects duplicate repos and stores gitlab without a connection', async () => {
    const existing = { id: 'r1', provider: 'github', repositoryId: '1', fullName: 'o/r', baseBranch: 'main', setupScript: null };
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ repos: [existing] })])); // bump latest
    const dup = await catchErr(
      service.addRepo(callerId, envId, undefined, { provider: 'github', repositoryId: '1', fullName: 'o/r' }),
    );
    expect(dup).toMatchObject({ status: 409, body: { code: 'conflict' } });
    expect(db.insert).not.toHaveBeenCalled();

    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ repos: [existing] })])); // bump latest
    db.insert.mockReturnValueOnce(insertQ([versionRow({ version: 2 })]));
    db.update.mockReturnValueOnce(updateQ([envRow({ currentVersion: 2 })]));
    queueView(envRow({ currentVersion: 2 }), versionRow({ version: 2 }), [{ id: 'inst-1' }]);
    const view = await service.addRepo(callerId, envId, undefined, {
      provider: 'gitlab',
      repositoryId: '99',
      fullName: 'team/app',
    });
    expect(view.connections).toEqual({ github: { connected: true }, gitlab: { connected: false } });
    expect(view.currentVersion).toBe(2);
  });

  it('stores secretsAccess on the environment row without bumping the version', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    const seen: { set?: unknown } = {};
    db.update.mockReturnValueOnce({ set: (v: unknown) => { seen.set = v; return { where: () => ({ returning: () => Promise.resolve([envRow({ secretsAccess: 'admins' })]) }) }; } });
    queueView(envRow({ secretsAccess: 'admins' }));
    const patched = await service.update(callerId, envId, undefined, { secretsAccess: 'admins' });
    expect(patched.secretsAccess).toBe('admins');
    expect(seen.set).toMatchObject({ secretsAccess: 'admins' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses members changing secretsAccess and unknown values', async () => {
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
    const denied = await catchErr(service.update(callerId, envId, undefined, { secretsAccess: 'members' }));
    expect(denied).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    db.select.mockReturnValueOnce(selectQ([envRow()]));
    const bad = await catchErr(service.update(callerId, envId, undefined, { secretsAccess: 'everyone' as never }));
    expect(bad.status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  describe('assertSecretsLaunchable', () => {
    const member = () => orgs.requireMembership.mockResolvedValue({ role: 'member' });
    const queue = (access: string, version: unknown) => {
      db.select.mockReturnValueOnce(selectQ([envRow({ secretsAccess: access })])).mockReturnValueOnce(selectQ([version]));
    };

    it('lets members launch from the default members environment', async () => {
      member();
      queue('members', versionRow({ envVars: { A: seal('x') } }));
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'base', { pin: 'v1' })).resolves.toBeUndefined();
    });

    it('refuses members on admins-only environments that inject anything', async () => {
      member();
      queue('admins', versionRow({ envVars: { A: seal('x') } }));
      const err = await catchErr(service.assertSecretsLaunchable(callerId, orgId, 'base'));
      expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    });

    it('lets admins and owners through', async () => {
      for (const role of ['admin', 'owner']) {
        orgs.requireMembership.mockResolvedValueOnce({ role });
        db.select.mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'admins' })])).mockReturnValueOnce(selectQ([versionRow()]));
        await expect(service.assertSecretsLaunchable(callerId, orgId, 'base')).resolves.toBeUndefined();
      }
    });

    it('does not block environments with nothing injectable, safe, or noEnv launches', async () => {
      member();
      const bare = { passSecrets: false, passAgentsCredentials: false, passDockCredentials: false };
      queue('admins', versionRow({ ...bare, envVars: { A: seal('x') } }));
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'base')).resolves.toBeUndefined();
      queue('admins', versionRow({ ...bare, passAgentsCredentials: true, safeForThirdParties: true }));
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'base')).resolves.toBeUndefined();
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'base', { noEnv: true })).resolves.toBeUndefined();
      expect(db.select).toHaveBeenCalledTimes(4);
    });

    it('judges the pinned version, and tolerates a deleted environment', async () => {
      member();
      db.select
        .mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'admins' })]))
        .mockReturnValueOnce(selectQ([versionRow({ version: 3 })]))
        .mockReturnValueOnce(selectQ([versionRow({ version: 2, passSecrets: false, passAgentsCredentials: false, passDockCredentials: false })]));
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'base', { pin: 'v2' })).resolves.toBeUndefined();
      db.select.mockReturnValueOnce(selectQ([]));
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'gone')).resolves.toBeUndefined();
    });
  });

  describe('assertDockSecretsReadable', () => {
    const dock = (over: Record<string, unknown> = {}) => ({ createdAt: new Date('2026-03-01'), createdBy: 'admin-1', environment: 'base', envVersionPin: 'v1', noEnv: false, ...over });
    const queue = () => db.select.mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'admins' })])).mockReturnValueOnce(selectQ([versionRow({ version: 2 })])).mockReturnValueOnce(selectQ([versionRow({ version: 1, envVars: { A: seal('x') } })]));

    it('refuses a member reading another creator\'s dock that received admins-only secrets', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      queue();
      const err = await catchErr(service.assertDockSecretsReadable(callerId, orgId, dock()));
      expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    });

    it('lets the creator, admins and owners through, and docks that got no bundle', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      await expect(service.assertDockSecretsReadable(callerId, orgId, dock({ createdBy: callerId }))).resolves.toBeUndefined();
      await expect(service.assertDockSecretsReadable(callerId, orgId, dock({ noEnv: true }))).resolves.toBeUndefined();
      expect(db.select).not.toHaveBeenCalled();
      for (const role of ['admin', 'owner']) {
        orgs.requireMembership.mockResolvedValueOnce({ role });
        queue();
        await expect(service.assertDockSecretsReadable(callerId, orgId, dock())).resolves.toBeUndefined();
      }
    });

    it('honours the recorded pin', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      db.select
        .mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'admins' })]))
        .mockReturnValueOnce(selectQ([versionRow({ version: 3 })]))
        .mockReturnValueOnce(selectQ([versionRow({ version: 1, passSecrets: false, passAgentsCredentials: false, passDockCredentials: false })]));
      await expect(service.assertDockSecretsReadable(callerId, orgId, dock())).resolves.toBeUndefined();
    });

    it('fails closed for members when the environment is deleted, but not for admins or the creator', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      db.select.mockReturnValueOnce(selectQ([]));
      const err = await catchErr(service.assertDockSecretsReadable(callerId, orgId, dock({ environment: 'gone' })));
      expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
      for (const role of ['admin', 'owner']) {
        orgs.requireMembership.mockResolvedValueOnce({ role });
        db.select.mockReturnValueOnce(selectQ([]));
        await expect(service.assertDockSecretsReadable(callerId, orgId, dock({ environment: 'gone' }))).resolves.toBeUndefined();
      }
      await expect(service.assertDockSecretsReadable(callerId, orgId, dock({ environment: 'gone', createdBy: callerId }))).resolves.toBeUndefined();
    });

    it('refuses members when a same-name environment was created after the dock, even if it is open to members', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      db.select.mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'members', createdAt: new Date('2026-06-01') })])).mockReturnValueOnce(selectQ([versionRow()]));
      const err = await catchErr(service.assertDockSecretsReadable(callerId, orgId, dock({ createdAt: new Date('2026-03-01') })));
      expect(err).toMatchObject({ status: 403 });
      db.select.mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'members', createdAt: new Date('2026-06-01') })])).mockReturnValueOnce(selectQ([versionRow()]));
      await expect(service.assertDockSecretsReadable(callerId, orgId, dock({ noEnv: true, createdAt: new Date('2026-03-01') }))).resolves.toBeUndefined();
    });

    it('compares against envBoundAt, so a dock resumed onto a newer members environment stays readable', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      const newer = () => db.select.mockReturnValueOnce(selectQ([envRow({ secretsAccess: 'members', createdAt: new Date('2026-06-01') })])).mockReturnValueOnce(selectQ([versionRow()]));
      newer();
      await expect(service.assertDockSecretsReadable(callerId, orgId, dock({ createdAt: new Date('2026-03-01'), envBoundAt: new Date('2026-07-01') }))).resolves.toBeUndefined();
      // A same-name environment re-created after the dock was bound still refuses.
      newer();
      const err = await catchErr(service.assertDockSecretsReadable(callerId, orgId, dock({ createdAt: new Date('2026-03-01'), envBoundAt: new Date('2026-05-01') })));
      expect(err).toMatchObject({ status: 403 });
    });

    it('the launch path still passes through a deleted environment', async () => {
      orgs.requireMembership.mockResolvedValue({ role: 'member' });
      db.select.mockReturnValueOnce(selectQ([]));
      await expect(service.assertSecretsLaunchable(callerId, orgId, 'gone')).resolves.toBeUndefined();
    });
  });

  it('resolves nothing for unknown environments', async () => {
    db.select.mockReturnValueOnce(selectQ([])); // resolveVersion env
    const err = await catchErr(service.resolveVersion(orgId, 'nope'));
    expect(err).toMatchObject({ status: 404, body: { code: 'environment_not_found' } });
  });

  it('upgrade moves the pin of older docks', async () => {
    const oldDock = {
      id: '44444444-4444-4444-8444-444444444444',
      workspaceId: 'ws-1',
      environment: 'base',
      envVersionPin: 'v1',
    };
    db.select.mockReturnValueOnce(selectQ([envRow()])); // resolveRef
    db.select.mockReturnValueOnce(selectQ([versionRow({ version: 3 })])); // latest
    db.select.mockReturnValueOnce(selectQ([{ id: 'ws-1' }])); // workspaces
    db.select.mockReturnValueOnce(selectQ([oldDock])); // d1
    const sets: any[] = [];
    db.update.mockImplementation(() => ({
      set: (values: unknown) => {
        sets.push(values);
        return { where: () => Promise.resolve([]) };
      },
    }));
    const res = await service.upgrade(callerId, envId, undefined, [oldDock.id]);
    expect(res).toMatchObject({ operation: { id: 'op_1', status: 'completed' }, moved: [oldDock.id] });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ envVersionPin: 'v3' });
    expect(Object.keys(sets[0]).sort()).toEqual(['envVersionPin', 'updatedAt']);
  });
});
