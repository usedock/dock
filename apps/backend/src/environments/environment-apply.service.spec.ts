import { generateKeyPairSync } from 'crypto';
import { vi, type Mock } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { cloneTokenVar } from './env-apply-script';
import { EnvironmentApplyService } from './environment-apply.service';
import { EnvironmentNotFoundException } from './environments.service';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const repo = { id: 'r1', provider: 'github', repositoryId: 'acme/web', fullName: 'acme/web', baseBranch: null, setupScript: null };
const dock = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'dock-abc',
  environment: 'base',
  envVersionPin: 'v2',
  env: { PER_DOCK: '1' },
  noEnv: false,
  state: 'ready',
  createdBy: userId,
  setupStatus: 'pending',
  updatedAt: new Date(0),
  ...overrides,
});
const bundle = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  vars: { A: '1' },
  files: [],
  repos: [],
  injectedProviders: [],
  passDockCredentials: true,
  ...overrides,
});
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false });
const decodeEnvFile = (script: string) => {
  const chunk = /printf '%s' '([A-Za-z0-9+/=]+)' >> "\$HOME"\/'\.dock\/env\.sh\.dock-part'/.exec(script)?.[1] ?? '';
  return Buffer.from(chunk, 'base64').toString();
};

describe('EnvironmentApplyService', () => {
  let db: any;
  let envs: { resolveBundle: Mock; upgrade: Mock };
  let provider: { exec: Mock };
  let config: Record<string, string>;
  let sets: any[];
  let inserted: any[];
  let service: EnvironmentApplyService;

  beforeEach(() => {
    sets = [];
    inserted = [];
    config = { RUNTIME_DRIVER: 'restate', PUBLIC_API_URL: 'https://api.example.test' };
    db = {
      select: vi.fn(),
      delete: vi.fn(() => ({ where: () => Promise.resolve([]) })),
      insert: vi.fn(() => ({ values: (v: unknown) => { inserted.push(v); return Promise.resolve([]); } })),
      update: vi.fn(() => ({
        set: (values: unknown) => {
          sets.push(values);
          return { where: () => ({ returning: () => Promise.resolve([dock(values as never)]) }) };
        },
      })),
    };
    envs = { resolveBundle: vi.fn().mockResolvedValue(bundle()), upgrade: vi.fn() };
    provider = { exec: vi.fn().mockResolvedValue(ok()) };
    const moduleRef = { get: vi.fn().mockReturnValue(provider) };
    service = new EnvironmentApplyService(db as never, envs as never, moduleRef as never, { get: (k: string) => config[k] } as never);
  });

  it('resolves the pinned version with per-dock env and agents, then marks done', async () => {
    const out = await service.apply(dock() as never, orgId);
    expect(envs.resolveBundle).toHaveBeenCalledWith(orgId, 'base', {
      version: 2,
      perDockEnv: { PER_DOCK: '1' },
      noEnv: false,
      agents: ['opencode'],
    });
    expect(sets.map((s) => s.setupStatus)).toEqual(['running', 'done']);
    expect(out.setupStatus).toBe('done');
  });

  it('injects dock identity and a fresh dock-bound key acting as the creator', async () => {
    await service.apply(dock() as never, orgId);
    const envFile = decodeEnvFile(provider.exec.mock.calls[0][1].script);
    expect(envFile).toContain("export DOCK_ID='d1'");
    expect(envFile).toContain("export DOCK_API_URL='https://api.example.test'");
    const key = /export DOCK_API_KEY='(dock_[^']+)'/.exec(envFile)?.[1] ?? '';
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([expect.objectContaining({ userId, dockId: 'd1', keyHash: hashToken(key) })]);
  });

  describe("creator's ChatGPT sign-in", () => {
    const agentDock = (over: Record<string, unknown> = {}) => dock(over);
    let chatgpt: { usable: Mock };

    beforeEach(() => {
      chatgpt = { usable: vi.fn().mockResolvedValue(true) };
      const moduleRef = { get: vi.fn().mockReturnValue(provider) };
      service = new EnvironmentApplyService(db as never, envs as never, moduleRef as never, { get: (k: string) => config[k] } as never, chatgpt as never);
      envs.resolveBundle.mockResolvedValue(bundle({ passAgentsCredentials: true }));
    });

    it('wires the default dock agent to the gateway with a fresh dock token, never a ChatGPT token', async () => {
      await service.apply(agentDock() as never, orgId);
      expect(chatgpt.usable).toHaveBeenCalledWith(userId);
      const script = provider.exec.mock.calls[0][1].script as string;
      const envFile = decodeEnvFile(script);
      const token = /export DOCK_LLM_TOKEN='([0-9a-f]{64})'/.exec(envFile)?.[1] ?? '';
      expect(sets).toContainEqual({ llmTokenHash: hashToken(token) });
      expect(envFile).not.toContain('CODEX_HOME');
      expect(envFile).toContain('"baseURL":"https://api.example.test/v1/llm/chatgpt"');
      expect(envFile).toContain(`"access":"${token}"`);
    });

    it('clears a previous token when the posture withholds agent credentials or the sign-in is gone', async () => {
      envs.resolveBundle.mockResolvedValueOnce(bundle({ passAgentsCredentials: false }));
      await service.apply(agentDock({ llmTokenHash: 'old' }) as never, orgId);
      expect(sets).toContainEqual({ llmTokenHash: null });
      chatgpt.usable.mockResolvedValueOnce(false);
      await service.apply(agentDock() as never, orgId);
      expect(decodeEnvFile(provider.exec.mock.calls[1][1].script)).not.toContain('DOCK_LLM_TOKEN');
    });

  });

  it('wires connectors to the gateway with a fresh dock token and writes the MCP config', async () => {
    await service.apply(dock({ connectors: ['linear', 'slack'] }) as never, orgId);
    const envFile = decodeEnvFile(provider.exec.mock.calls[0][1].script);
    const token = /export DOCK_CONNECTOR_TOKEN='([0-9a-f]{64})'/.exec(envFile)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(sets).toContainEqual({ connectorTokenHash: hashToken(token) });
    expect(envFile).toContain("export DOCK_LINEAR_API_URL='https://api.example.test/v1/connectors/gateway/linear/api'");
    expect(envFile).toContain("export DOCK_LINEAR_MCP_URL='https://api.example.test/v1/connectors/gateway/linear/mcp'");
    expect(envFile).not.toContain('DOCK_SLACK_MCP_URL');
    expect(provider.exec.mock.calls[0][1].script).toContain('.config/dock/mcp.json');
  });

  it('mints no connector token for docks without connectors', async () => {
    await service.apply(dock() as never, orgId);
    expect(sets.some((s) => 'connectorTokenHash' in s)).toBe(false);
    expect(decodeEnvFile(provider.exec.mock.calls[0][1].script)).not.toContain('DOCK_CONNECTOR_TOKEN');
  });

  it('withholds the key and deletes any previous one when the posture says so', async () => {
    envs.resolveBundle.mockResolvedValueOnce(bundle({ passDockCredentials: false }));
    await service.apply(dock() as never, orgId);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([]);
    expect(decodeEnvFile(provider.exec.mock.calls[0][1].script)).not.toContain('DOCK_API_KEY');
  });

  it('mints no key for docks without a recorded creator', async () => {
    await service.apply(dock({ createdBy: null }) as never, orgId);
    expect(inserted).toEqual([]);
  });

  it('records a failed apply without throwing or leaking values', async () => {
    provider.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'base64: invalid input', truncated: false, timedOut: false });
    const out = await service.apply(dock() as never, orgId);
    expect(out.setupStatus).toBe('failed');
    expect(sets[1].setupError).toContain('exited 1');
    expect(sets[1].setupError).not.toContain('PER_DOCK');
  });

  it('still applies per-dock env when the environment was deleted, without a key', async () => {
    envs.resolveBundle.mockRejectedValueOnce(new EnvironmentNotFoundException());
    const out = await service.apply(dock() as never, orgId);
    expect(out.setupStatus).toBe('done');
    const envFile = decodeEnvFile(provider.exec.mock.calls[0][1].script);
    expect(envFile).toContain("export PER_DOCK='1'");
    expect(envFile).not.toContain('DOCK_API_KEY');
  });

  it('stays running while background clones settle, done at once on the fake driver', async () => {
    envs.resolveBundle.mockResolvedValue(bundle({ repos: [repo] }));
    expect((await service.apply(dock() as never, orgId)).setupStatus).toBe('running');
    config.RUNTIME_DRIVER = 'fake';
    expect((await service.apply(dock() as never, orgId)).setupStatus).toBe('done');
  });

  it('passes a read-only installation token for github repos through exec env only', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.GITHUB_APP_ID = '42';
    config.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    envs.resolveBundle.mockResolvedValue(bundle({ repos: [repo] }));
    db.select.mockReturnValueOnce({
      from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([{ installationId: 7, repos: [repo.fullName] }]) }) }),
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'ghs_clone', expires_at: '' }) });
    service.fetchFn = fetchFn as never;
    await service.apply(dock() as never, orgId);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.github.com/app/installations/7/access_tokens');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ repositories: ['web'], permissions: { contents: 'read' } });
    const call = provider.exec.mock.calls[0][1];
    expect(call.env).toEqual({ [cloneTokenVar(repo as never)]: 'ghs_clone' });
    expect(call.script).not.toContain('ghs_clone');
  });

  it('mints no clone token for a repo outside every installation list', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.GITHUB_APP_ID = '42';
    config.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    envs.resolveBundle.mockResolvedValue(bundle({ repos: [repo] }));
    db.select.mockReturnValueOnce({
      from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([{ installationId: 7, repos: ['acme/other'] }]) }) }),
    });
    const fetchFn = vi.fn();
    service.fetchFn = fetchFn as never;
    await service.apply(dock() as never, orgId);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(provider.exec.mock.calls[0][1].env).toEqual({});
  });

  it('matches installation repos case-insensitively', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.GITHUB_APP_ID = '42';
    config.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    envs.resolveBundle.mockResolvedValue(bundle({ repos: [repo] }));
    db.select.mockReturnValueOnce({
      from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([{ installationId: 7, repos: ['Acme/Web'] }]) }) }),
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'ghs_clone', expires_at: '' }) });
    service.fetchFn = fetchFn as never;
    await service.apply(dock() as never, orgId);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('applies upgrades to live moved docks only', async () => {
    envs.upgrade.mockResolvedValue({ operation: { id: 'op_1' }, moved: ['d1', 'd2'], orgId });
    db.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([dock()]) }) });
    const res = await service.upgrade('u1', 'base', orgId, undefined);
    expect(res).toEqual({ operation: { id: 'op_1' } });
    expect(envs.resolveBundle).toHaveBeenCalledTimes(1);
  });

  describe('watchOnce', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const running = (minutesAgo: number) => dock({ setupStatus: 'running', updatedAt: new Date(now - minutesAgo * 60_000) });
    const queueRows = (rows: unknown[]) => db.select.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(rows) }) });

    it('settles done and failed from setup.status and waits on running', async () => {
      queueRows([running(1), { ...running(1), id: 'd2' }, { ...running(1), id: 'd3' }]);
      provider.exec
        .mockResolvedValueOnce(ok('done\n'))
        .mockResolvedValueOnce(ok(' clone:web setup:dock\n'))
        .mockResolvedValueOnce(ok('running\n'));
      const res = await service.watchOnce(now);
      expect(res).toEqual({ settled: 2 });
      expect(sets).toEqual([
        expect.objectContaining({ setupStatus: 'done', setupError: null }),
        expect.objectContaining({ setupStatus: 'failed', setupError: expect.stringContaining('clone:web setup:dock') }),
      ]);
    });

    it('fails setups past the deadline without asking the guest', async () => {
      queueRows([running(61)]);
      await service.watchOnce(now);
      expect(provider.exec).not.toHaveBeenCalled();
      expect(sets[0]).toMatchObject({ setupStatus: 'failed' });
    });

    it('leaves the row alone when the guest cannot be reached', async () => {
      queueRows([running(1)]);
      provider.exec.mockRejectedValueOnce(new Error('exec_unavailable'));
      expect(await service.watchOnce(now)).toEqual({ settled: 0 });
      expect(sets).toEqual([]);
    });
  });
});
