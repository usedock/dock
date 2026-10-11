import { vi, type Mock } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { ConnectorRunsService } from './connector-runs.service';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const connector = { id: 'c1', workspaceId: 'w1', kind: 'slack', createdBy: 'admin-1' };
const trigger = { kind: 'slack' as const, key: 'thread:C1:1.1', title: 'Slack mention', body: 'look at the failing build', url: null, reply: { channel: 'C1', threadTs: '1.1' } };
const runRow = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  workspaceId: 'w1',
  organizationId: 'o1',
  kind: 'slack',
  state: 'pending',
  agent: 'opencode',
  model: null,
  triggerKey: trigger.key,
  reply: trigger.reply,
  dockId: null,
  completionTokenHash: hashToken('tok-1'),
  gatewayTokenHash: hashToken('tok-2'),
  summary: null,
  reason: null,
  createdAt: new Date(),
  ...over,
});

/** Selects resolve queued rows in call order; updates resolve queued rows too (empty array means a lost state guard). */
function fakeDb(selects: unknown[][], updates: unknown[][] = []) {
  const selectQueue = [...selects];
  const updateQueue = [...updates];
  const chain = (rows: unknown[]) => Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows), returning: vi.fn().mockResolvedValue(rows) });
  const insertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([runRow()]) });
  const updateSet = vi.fn();
  return {
    select: vi.fn().mockImplementation(() => ({ from: () => ({ where: () => chain(selectQueue.shift() ?? []) }) })),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockImplementation(() => ({
      set: (patch: unknown) => {
        updateSet(patch);
        return { where: () => chain(updateQueue.shift() ?? [runRow({ state: 'working', dockId: 'dock-1' })]) };
      },
    })),
    insertValues,
    updateSet,
  };
}

describe('ConnectorRunsService', () => {
  let docks: { create: Mock; stop: Mock };
  let provider: { exec: Mock };
  let connectors: { accessFor: Mock; pruneDeliveries: Mock };
  let envs: { resolveBundle: Mock };
  let fetchFn: Mock;
  let config: Record<string, string>;
  const tokens = ['tok-1', 'tok-2'];

  const build = (db: ReturnType<typeof fakeDb>) => {
    let n = 0;
    return new ConnectorRunsService(db as never, docks as never, provider as never, connectors as never, envs as never, { get: (k: string) => config[k] } as never, {
      fetchFn: fetchFn as never,
      tokenFn: () => tokens[n++ % 2],
    });
  };
  const texts = () => fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).text);

  beforeEach(() => {
    docks = { create: vi.fn().mockResolvedValue({ id: 'dock-1' }), stop: vi.fn().mockResolvedValue({}) };
    provider = { exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false }) };
    connectors = { accessFor: vi.fn().mockResolvedValue({ type: 'oauth', access: 'xoxb' }), pruneDeliveries: vi.fn().mockResolvedValue(undefined) };
    envs = { resolveBundle: vi.fn().mockResolvedValue({ vars: { ANTHROPIC_API_KEY: 'sk-real' } }) };
    fetchFn = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    config = { PUBLIC_API_URL: 'https://api.example.test' };
  });

  describe('start', () => {
    it('creates a connector dock without the environment, for the connecting admin, and launches with run-scoped tokens only', async () => {
      const db = fakeDb([[], [{ organizationId: 'o1' }]]);
      const service = build(db);
      expect(await service.start(connector as never, trigger)).toEqual({ status: 'started', id: RUN_ID });
      await service.settled();
      expect(docks.create).toHaveBeenCalledWith('admin-1', expect.objectContaining({ workspaceId: 'w1', connectors: ['slack'], noEnv: true }), `connector-run:${RUN_ID}`);
      const [, request] = provider.exec.mock.calls[0];
      // The control plane keeps the provider key; the dock gets the gateway token and the completion token.
      expect(request.env).toEqual({ CONNECTOR_RUN_TOKEN: 'tok-1', DOCK_LLM_TOKEN: 'tok-2' });
      expect(JSON.stringify(request)).not.toContain('sk-real');
      expect(request.script).not.toContain('tok-1');
      expect(request.script).not.toContain('tok-2');
      expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({ completionTokenHash: hashToken('tok-1'), gatewayTokenHash: hashToken('tok-2'), organizationId: 'o1', agent: 'opencode', triggerKey: trigger.key }));
      expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-5' }));
      expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ channel: 'C1', thread_ts: '1.1', text: 'On it.' });
    });

    it('passes the operator setup script to the dock and nothing else of the environment', async () => {
      config.CONNECTOR_RUN_SETUP_SCRIPT = 'npm i -g opencode-ai';
      const service = build(fakeDb([[], [{ organizationId: 'o1' }]]));
      await service.start(connector as never, trigger);
      await service.settled();
      expect(docks.create.mock.calls[0][1]).toMatchObject({ setupScript: 'npm i -g opencode-ai', noEnv: true });
      expect(docks.create.mock.calls[0][1].env).toBeUndefined();
    });

    it('does not start a second run for a subject that has one in flight', async () => {
      const db = fakeDb([[{ kind: 'slack', triggerKey: trigger.key }]]);
      expect(await build(db).start(connector as never, trigger)).toEqual({ status: 'duplicate' });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('answers busy at the per-workspace cap and starts no dock', async () => {
      config.CONNECTOR_RUN_MAX_CONCURRENT = '2';
      const db = fakeDb([[{ kind: 'slack', triggerKey: 'a' }, { kind: 'linear', triggerKey: 'b' }]]);
      expect(await build(db).start(connector as never, trigger)).toEqual({ status: 'busy' });
      expect(db.insert).not.toHaveBeenCalled();
      expect(docks.create).not.toHaveBeenCalled();
    });

    it('defaults the cap to five', async () => {
      const five = Array.from({ length: 5 }, (_, i) => ({ kind: 'linear', triggerKey: `k${i}` }));
      expect(await build(fakeDb([five])).start(connector as never, trigger)).toEqual({ status: 'busy' });
      expect(await build(fakeDb([five.slice(0, 4), [{ organizationId: 'o1' }]])).start(connector as never, trigger)).toMatchObject({ status: 'started' });
    });

    it('fails the run with a reply when the connecting admin is gone', async () => {
      const service = build(fakeDb([[], [{ organizationId: 'o1' }]], [[runRow({ state: 'failed', reason: 'no_owner' })]]));
      await service.start({ ...connector, createdBy: null } as never, trigger);
      await service.settled();
      expect(docks.create).not.toHaveBeenCalled();
      expect(texts()).toContain('Dock could not finish this (no_owner).');
    });

    it('fails the run when no model key is configured for the organization', async () => {
      envs.resolveBundle.mockResolvedValue({ vars: {} });
      const service = build(fakeDb([[], [{ organizationId: 'o1' }]], [[runRow({ state: 'failed', reason: 'provider_not_configured' })]]));
      await service.start(connector as never, trigger);
      await service.settled();
      expect(docks.create).not.toHaveBeenCalled();
      expect(texts()).toContain('Dock could not finish this (provider_not_configured).');
    });

    it('honors a model override only when its provider has a key', async () => {
      config.CONNECTOR_RUN_MODEL = 'openai/gpt-5';
      const service = build(fakeDb([[], [{ organizationId: 'o1' }]], [[runRow({ state: 'failed', reason: 'provider_not_configured' })]]));
      await service.start(connector as never, trigger);
      await service.settled();
      expect(docks.create).not.toHaveBeenCalled();
    });

    it('fails the run when the dock cannot be created, for example the admin lost their role', async () => {
      docks.create.mockRejectedValue(new Error('403'));
      const service = build(fakeDb([[], [{ organizationId: 'o1' }]], [[runRow({ model: 'm' })], [runRow({ state: 'failed', reason: 'dock_provision_failed' })]]));
      await service.start(connector as never, trigger);
      await service.settled();
      expect(provider.exec).not.toHaveBeenCalled();
      expect(texts()).toContain('Dock could not finish this (dock_provision_failed).');
    });

    it('fails the run and stops the dock when the launch exits non-zero', async () => {
      provider.exec.mockResolvedValue({ exitCode: 3, stdout: '', stderr: 'x', truncated: false });
      const db = fakeDb(
        [[], [{ organizationId: 'o1' }], [{ createdBy: 'admin-1' }]],
        [[runRow({ model: 'm' })], [runRow({ state: 'working', dockId: 'dock-1' })], [runRow({ state: 'failed', reason: 'launch_failed', dockId: 'dock-1' })]],
      );
      const service = build(db);
      await service.start(connector as never, trigger);
      await service.settled();
      expect(texts()).toContain('Dock could not finish this (launch_failed).');
      expect(docks.stop).toHaveBeenCalledWith('admin-1', 'dock-1', {});
    });
  });

  describe('complete', () => {
    it('refuses a missing or wrong token without touching the run', async () => {
      const db = fakeDb([[runRow()], [runRow()], [runRow()]]);
      const service = build(db);
      await expect(service.complete(RUN_ID, undefined, { status: 'done' })).rejects.toMatchObject({ response: { code: 'invalid_completion_token' } });
      await expect(service.complete(RUN_ID, 'Bearer wrong', { status: 'done' })).rejects.toMatchObject({ response: { code: 'invalid_completion_token' } });
      // The LLM gateway token is not the completion token.
      await expect(service.complete(RUN_ID, 'Bearer tok-2', { status: 'done' })).rejects.toMatchObject({ response: { code: 'invalid_completion_token' } });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('404s an unknown or malformed run id', async () => {
      await expect(build(fakeDb([[]])).complete(RUN_ID, 'Bearer tok-1', { status: 'done' })).rejects.toMatchObject({ response: { code: 'connector_run_not_found' } });
      await expect(build(fakeDb([])).complete('not-a-uuid', 'Bearer tok-1', { status: 'done' })).rejects.toMatchObject({ response: { code: 'connector_run_not_found' } });
    });

    it('rejects an unknown status', async () => {
      await expect(build(fakeDb([[runRow()]])).complete(RUN_ID, 'Bearer tok-1', { status: 'maybe' })).rejects.toMatchObject({ response: { code: 'validation_error' } });
    });

    it('scrubs secrets from the stored summary and from the reply, then stops the dock to revoke the tokens', async () => {
      const leak = `done. env: ${'ab'.repeat(32)} xoxb-1234567890-abcdefABC sk-ant-api03-abcdefghij`;
      const clean = (v: string) => v.replace(/ab{0}(ab){32}/, '[redacted]');
      const db = fakeDb([[runRow({ state: 'working' })], [{ createdBy: 'admin-1' }]], [[runRow({ state: 'succeeded', summary: clean(leak), dockId: 'dock-1' })]]);
      const service = build(db);
      expect(await service.complete(RUN_ID, 'Bearer tok-1', { status: 'done', summary: leak })).toEqual({ runId: RUN_ID, state: 'succeeded' });
      await service.settled();
      const stored = db.updateSet.mock.calls[0][0].summary as string;
      expect(stored).not.toMatch(/abab|xoxb|sk-ant/);
      expect(stored).toContain('[redacted]');
      expect(texts()[0]).not.toMatch(/abab|xoxb|sk-ant/);
      expect(docks.stop).toHaveBeenCalledWith('admin-1', 'dock-1', {});
    });

    it('moves a Linear issue to completed after a done run and not after a failed one', async () => {
      const nodes = { data: { issue: { team: { states: { nodes: [{ id: 's', type: 'completed', position: 1 }] } } } } };
      fetchFn.mockImplementation(async () => new Response(JSON.stringify(nodes), { status: 200 }));
      const linearRun = runRow({ kind: 'linear', state: 'succeeded', summary: 'Done it', reply: { issueId: 'i1' } });
      const service = build(fakeDb([[runRow({ kind: 'linear', state: 'working' })]], [[linearRun]]));
      await service.complete(RUN_ID, 'Bearer tok-1', { status: 'done', summary: 'Done it' });
      await service.settled();
      const queries = () => fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).query as string);
      expect(queries().some((q) => q.includes('commentCreate'))).toBe(true);
      expect(queries().some((q) => q.includes('issueUpdate'))).toBe(true);

      fetchFn.mockClear();
      const failed = runRow({ kind: 'linear', state: 'failed', reason: 'agent_failed', reply: { issueId: 'i1' } });
      const service2 = build(fakeDb([[runRow({ kind: 'linear', state: 'working' })]], [[failed]]));
      await service2.complete(RUN_ID, 'Bearer tok-1', { status: 'failed', reason: 'agent_failed' });
      await service2.settled();
      expect(queries().some((q) => q.includes('issueUpdate'))).toBe(false);
    });

    it('ignores a second completion once the run is settled', async () => {
      const service = build(fakeDb([[runRow({ state: 'succeeded' })]], [[]]));
      expect(await service.complete(RUN_ID, 'Bearer tok-1', { status: 'done' })).toEqual({ runId: RUN_ID, state: 'succeeded' });
      await service.settled();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('sweepTimeouts', () => {
    it('sweeps runs whose dock never reported, replying once and pruning dedupe rows', async () => {
      const stale = runRow({ state: 'working', dockId: 'dock-1' });
      const db = fakeDb([[stale], [{ createdBy: 'admin-1' }]], [[runRow({ state: 'timed_out', reason: 'timed_out', dockId: 'dock-1' })]]);
      const service = build(db);
      expect(await service.sweepTimeouts()).toEqual({ swept: 1 });
      expect(texts()).toEqual(['Dock could not finish this (timed_out).']);
      expect(docks.stop).toHaveBeenCalled();
      expect(connectors.pruneDeliveries).toHaveBeenCalled();
    });

    it('does not overwrite or re-announce a run a completion settled between the select and the update', async () => {
      const stale = runRow({ state: 'working', dockId: 'dock-1' });
      // The guarded update matches no row because the state is no longer pending or working.
      const service = build(fakeDb([[stale]], [[]]));
      await service.sweepTimeouts();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(docks.stop).not.toHaveBeenCalled();
    });
  });

  it('notify posts a scrubbed notice through the connector credential', async () => {
    const service = build(fakeDb([]));
    service.notify('w1', 'slack', { channel: 'C1', threadTs: '1.1' }, `no ${'ab'.repeat(32)}`);
    await service.settled();
    expect(texts()).toEqual(['no [redacted]']);
  });
});
