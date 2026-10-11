import { vi, type Mock } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { ConnectorRunsService } from './connector-runs.service';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const connector = { id: 'c1', workspaceId: 'w1', kind: 'slack', createdBy: 'admin-1' };
const trigger = { kind: 'slack' as const, key: 'thread:C1:1.1', title: 'Slack mention', body: 'look at the failing build', url: null, reply: { channel: 'C1', threadTs: '1.1' } };
const runRow = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  workspaceId: 'w1',
  kind: 'slack',
  state: 'pending',
  triggerKey: trigger.key,
  reply: trigger.reply,
  dockId: null,
  completionTokenHash: hashToken('tok'),
  summary: null,
  reason: null,
  createdAt: new Date(),
  ...over,
});

/** Each select/update resolves the next queued result; insert returns the run row. */
function fakeDb(selects: unknown[][], updates: unknown[][] = []) {
  const selectQueue = [...selects];
  const updateQueue = [...updates];
  const chain = (rows: unknown[]) => {
    const end: any = Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows), returning: vi.fn().mockResolvedValue(rows) });
    return end;
  };
  const insertReturning = vi.fn().mockResolvedValue([runRow()]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  return {
    select: vi.fn().mockImplementation(() => ({ from: () => ({ where: () => chain(selectQueue.shift() ?? []) }) })),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    update: vi.fn().mockImplementation(() => ({ set: () => ({ where: () => chain(updateQueue.shift() ?? [runRow({ state: 'working', dockId: 'dock-1' })]) }) })),
    insertValues,
  };
}

describe('ConnectorRunsService', () => {
  let docks: { create: Mock; stop: Mock };
  let provider: { exec: Mock };
  let connectors: { accessFor: Mock; pruneDeliveries: Mock };
  let fetchFn: Mock;
  let config: Record<string, string>;

  const build = (db: ReturnType<typeof fakeDb>) =>
    new ConnectorRunsService(db as never, docks as never, provider as never, connectors as never, { get: (k: string) => config[k] } as never, { fetchFn: fetchFn as never, tokenFn: () => 'tok' });

  beforeEach(() => {
    docks = { create: vi.fn().mockResolvedValue({ id: 'dock-1' }), stop: vi.fn().mockResolvedValue({}) };
    provider = { exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false }) };
    connectors = { accessFor: vi.fn().mockResolvedValue({ type: 'oauth', access: 'xoxb' }), pruneDeliveries: vi.fn().mockResolvedValue(undefined) };
    fetchFn = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    config = { PUBLIC_API_URL: 'https://api.example.test' };
  });

  it('creates a connector dock for the admin who connected the tool and launches the agent with the run token', async () => {
    const db = fakeDb([[]]);
    const service = build(db);
    expect(await service.start(connector as never, trigger)).toBe(RUN_ID);
    await service.settled();
    expect(docks.create).toHaveBeenCalledWith('admin-1', expect.objectContaining({ workspaceId: 'w1', connectors: ['slack'] }), `connector-run:${RUN_ID}`);
    const [, request] = provider.exec.mock.calls[0];
    expect(request.env).toEqual({ CONNECTOR_RUN_TOKEN: 'tok' });
    expect(request.script).not.toContain('tok');
    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({ completionTokenHash: hashToken('tok'), triggerKey: trigger.key }));
    // Slack gets an acknowledgement in the thread.
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ channel: 'C1', thread_ts: '1.1', text: 'On it.' });
  });

  it('does not start a second run for a subject that has one in flight', async () => {
    const db = fakeDb([[{ id: 'existing' }]]);
    expect(await build(db).start(connector as never, trigger)).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
    expect(docks.create).not.toHaveBeenCalled();
  });

  it('fails the run with a reply when the connecting admin is gone', async () => {
    const db = fakeDb([[]], [[runRow({ state: 'failed', reason: 'no_owner' })]]);
    const service = build(db);
    await service.start({ ...connector, createdBy: null } as never, trigger);
    await service.settled();
    expect(docks.create).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).text)).toContain('Dock could not finish this (no_owner).');
  });

  it('fails the run when the dock cannot be created, for example the admin lost their role', async () => {
    docks.create.mockRejectedValue(new Error('403'));
    const db = fakeDb([[]], [[runRow({ state: 'failed', reason: 'dock_provision_failed' })]]);
    const service = build(db);
    await service.start(connector as never, trigger);
    await service.settled();
    expect(provider.exec).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });

  it('fails the run when the launch exits non-zero', async () => {
    provider.exec.mockResolvedValue({ exitCode: 3, stdout: '', stderr: 'x', truncated: false });
    const db = fakeDb([[]], [[runRow({ state: 'working', dockId: 'dock-1' })], [runRow({ state: 'failed', reason: 'launch_failed', dockId: 'dock-1' })]]);
    const service = build(db);
    await service.start(connector as never, trigger);
    await service.settled();
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).text)).toContain('Dock could not finish this (launch_failed).');
  });

  describe('complete', () => {
    it('refuses a missing or wrong token without touching the run', async () => {
      const db = fakeDb([[runRow()], [runRow()]]);
      const service = build(db);
      await expect(service.complete(RUN_ID, undefined, { status: 'done' })).rejects.toMatchObject({ response: { code: 'invalid_completion_token' } });
      await expect(service.complete(RUN_ID, 'Bearer wrong', { status: 'done' })).rejects.toMatchObject({ response: { code: 'invalid_completion_token' } });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('404s an unknown or malformed run id', async () => {
      await expect(build(fakeDb([[]])).complete(RUN_ID, 'Bearer tok', { status: 'done' })).rejects.toMatchObject({ response: { code: 'connector_run_not_found' } });
      await expect(build(fakeDb([])).complete('not-a-uuid', 'Bearer tok', { status: 'done' })).rejects.toMatchObject({ response: { code: 'connector_run_not_found' } });
    });

    it('rejects an unknown status', async () => {
      await expect(build(fakeDb([[runRow()]])).complete(RUN_ID, 'Bearer tok', { status: 'maybe' })).rejects.toMatchObject({ response: { code: 'validation_error' } });
    });

    it('records the result, posts the summary back and stops the dock', async () => {
      const done = runRow({ state: 'succeeded', summary: 'Fixed the build', dockId: 'dock-1' });
      const db = fakeDb([[runRow({ state: 'working' })], [{ createdBy: 'admin-1' }]], [[done]]);
      const service = build(db);
      expect(await service.complete(RUN_ID, 'Bearer tok', { status: 'done', summary: 'Fixed the build' })).toEqual({ runId: RUN_ID, state: 'succeeded' });
      await service.settled();
      expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ channel: 'C1', thread_ts: '1.1', text: 'Fixed the build' });
      expect(docks.stop).toHaveBeenCalledWith('admin-1', 'dock-1', {});
    });

    it('moves a Linear issue to completed after a done run and not after a failed one', async () => {
      const nodes = { data: { issue: { team: { states: { nodes: [{ id: 's', type: 'completed', position: 1 }] } } } } };
      fetchFn.mockImplementation(async () => new Response(JSON.stringify(nodes), { status: 200 }));
      const linearRun = runRow({ kind: 'linear', state: 'succeeded', summary: 'Done it', reply: { issueId: 'i1' } });
      const db = fakeDb([[runRow({ kind: 'linear', state: 'working' })]], [[linearRun]]);
      const service = build(db);
      await service.complete(RUN_ID, 'Bearer tok', { status: 'done', summary: 'Done it' });
      await service.settled();
      const bodies = fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).query as string);
      expect(bodies.some((q) => q.includes('commentCreate'))).toBe(true);
      expect(bodies.some((q) => q.includes('issueUpdate'))).toBe(true);

      fetchFn.mockClear();
      const failed = runRow({ kind: 'linear', state: 'failed', reason: 'agent_failed', reply: { issueId: 'i1' } });
      const db2 = fakeDb([[runRow({ kind: 'linear', state: 'working' })]], [[failed]]);
      const service2 = build(db2);
      await service2.complete(RUN_ID, 'Bearer tok', { status: 'failed', reason: 'agent_failed' });
      await service2.settled();
      expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).query as string).some((q) => q.includes('issueUpdate'))).toBe(false);
    });

    it('ignores a second completion once the run is settled', async () => {
      const db = fakeDb([[runRow({ state: 'succeeded' })]], [[]]);
      const service = build(db);
      expect(await service.complete(RUN_ID, 'Bearer tok', { status: 'done' })).toEqual({ runId: RUN_ID, state: 'succeeded' });
      await service.settled();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it('sweeps runs whose dock never reported, replying and pruning dedupe rows', async () => {
    const stale = runRow({ state: 'working', dockId: 'dock-1' });
    const db = fakeDb([[stale], [{ createdBy: 'admin-1' }]], [[runRow({ state: 'timed_out', reason: 'timed_out', dockId: 'dock-1' })]]);
    const service = build(db);
    expect(await service.sweepTimeouts()).toEqual({ swept: 1 });
    expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).text)).toContain('Dock could not finish this (timed_out).');
    expect(docks.stop).toHaveBeenCalled();
    expect(connectors.pruneDeliveries).toHaveBeenCalled();
  });
});
