import { UnauthorizedException } from '@nestjs/common';
import { HostCommandQueue, hashCredential } from './host-command-queue';
import { vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

type Rows = Array<Record<string, unknown>>;
type MockFn = ReturnType<typeof vi.fn>;

describe('HostCommandQueue', () => {
  let db: { select: MockFn; insert: MockFn; update: MockFn; delete: MockFn };
  let queue: HostCommandQueue;

  /** Every drizzle chain the service uses terminates in one of these shapes. */
  const chain = (rows: Rows) => {
    const p = Promise.resolve(rows);
    return {
      limit: () => p,
      orderBy: () => ({ limit: () => p }),
      returning: () => p,
      then: p.then.bind(p),
    };
  };
  const selectQ = (rows: Rows) => ({ from: () => ({ where: () => chain(rows) }) });
  const insertQ = (rows: Rows) => ({ values: () => ({ returning: () => Promise.resolve(rows), onConflictDoNothing: () => Promise.resolve(rows) }) });
  const updateQ = (rows: Rows) => ({ set: () => ({ where: () => chain(rows) }) });
  const deleteQ = () => ({ where: () => chain([]) });

  const commandRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'c1',
    hostId: 'h1',
    op: 'provision',
    payload: { dockId: 'd1' },
    idempotencyToken: 'tok-1',
    deadlineMs: 300_000,
    state: 'queued',
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date('2026-09-10T00:00:00Z'),
    claimedAt: null,
    completedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    vi.clearAllMocks();
    const config = { get: vi.fn((key: string) => ({ FLEET_TOKEN: 'fleet-token-at-least-16' })[key]) };
    queue = new HostCommandQueue(db as never, config as never);
  });

  it('refuses every fleet call when no token is configured', () => {
    const unconfigured = new HostCommandQueue(db as never, { get: () => undefined } as never);
    expect(() => unconfigured.assertToken('anything')).toThrow(UnauthorizedException);
  });

  it('refuses a wrong or absent token', () => {
    expect(() => queue.assertToken(undefined)).toThrow(UnauthorizedException);
    expect(() => queue.assertToken('wrong')).toThrow(UnauthorizedException);
    expect(() => queue.assertToken('fleet-token-at-least-16')).not.toThrow();
  });

  it('refuses a same-length token that only differs at the end, via constant-time comparison', () => {
    // Guards against a naive `!==` compare, which can leak match length through timing.
    expect(() => queue.assertToken('fleet-token-at-least-1X')).toThrow(UnauthorizedException);
    expect(() => queue.assertToken('')).toThrow(UnauthorizedException);
  });

  it('accepts the enrollment token only where the shared token is allowed', () => {
    expect(queue.isEnrollToken('fleet-token-at-least-16')).toBe(true);
    expect(queue.isEnrollToken('host-credential')).toBe(false);
    expect(queue.isEnrollToken(undefined)).toBe(false);
  });

  it('derives the host from its credential hash, never from the request', async () => {
    db.select.mockReturnValueOnce(selectQ([{ id: 'h1', hash: hashCredential('hc_secret') }]));
    await expect(queue.authenticateHost('hc_secret')).resolves.toBe('h1');
  });

  it('refuses an unknown credential and the shared token on host calls', async () => {
    db.select.mockReturnValue(selectQ([]));
    await expect(queue.authenticateHost('hc_nope')).rejects.toMatchObject({ response: { code: 'host_credential_unknown' } });
    await expect(queue.authenticateHost('fleet-token-at-least-16')).rejects.toThrow(UnauthorizedException);
    await expect(queue.authenticateHost(undefined)).rejects.toThrow(UnauthorizedException);
  });

  describe('legacy shared-token transition', () => {
    const legacyQueue = (flag: string | undefined) =>
      new HostCommandQueue(db as never, { get: (key: string) => ({ FLEET_TOKEN: 'fleet-token-at-least-16', FLEET_LEGACY_SHARED_TOKEN: flag })[key] } as never);

    it('is off by default: the shared token never authenticates a host', async () => {
      db.select.mockReturnValue(selectQ([{ id: 'h1' }]));
      await expect(legacyQueue(undefined).authenticateHost('fleet-token-at-least-16', 'h1')).rejects.toThrow(UnauthorizedException);
      await expect(legacyQueue('false').authenticateHost('fleet-token-at-least-16', 'h1')).rejects.toThrow(UnauthorizedException);
    });

    it('when on, lets the shared token act as a host that has no credential yet', async () => {
      db.select.mockReturnValueOnce(selectQ([{ id: 'h1' }]));
      await expect(legacyQueue('true').authenticateHost('fleet-token-at-least-16', 'h1')).resolves.toBe('h1');
    });

    it('when on, still refuses hosts that hold a credential, a missing hostId and other tokens', async () => {
      // The lookup filters credential_hash IS NULL, so an enrolled host yields no row.
      db.select.mockReturnValue(selectQ([]));
      await expect(legacyQueue('true').authenticateHost('fleet-token-at-least-16', 'enrolled')).rejects.toThrow(UnauthorizedException);
      await expect(legacyQueue('true').authenticateHost('fleet-token-at-least-16')).rejects.toThrow(UnauthorizedException);
      await expect(legacyQueue('true').authenticateHost('wrong', 'h1')).rejects.toThrow(UnauthorizedException);
    });
  });

  it('drops generation bindings whose command was pruned', async () => {
    const wheres: unknown[] = [];
    db.update.mockReturnValue(updateQ([]));
    db.delete.mockReturnValue({ where: (cond: unknown) => (wheres.push(cond), chain([])) });
    db.select.mockReturnValue(selectQ([]));
    await queue.poll('h1', 0);
    expect(wheres).toHaveLength(2);
    const binding = new PgDialect().sqlToQuery(wheres[1] as SQL);
    expect(binding.sql).toContain('"host_generations"');
    expect(binding.sql).toContain('not exists (select 1');
    expect(binding.params).toContain('h1');
  });

  it('returns null when no work arrives within the wait', async () => {
    db.update.mockReturnValue(updateQ([]));
    db.delete.mockReturnValue(deleteQ());
    db.select.mockReturnValue(selectQ([]));
    await expect(queue.poll('h1', 0)).resolves.toBeNull();
  });

  it('claims the queued command for the polling host', async () => {
    db.update
      .mockReturnValueOnce(updateQ([]))
      .mockReturnValueOnce(updateQ([]))
      .mockReturnValueOnce(updateQ([commandRow({ state: 'claimed' })]));
    db.delete.mockReturnValue(deleteQ());
    db.select.mockReturnValueOnce(selectQ([commandRow()]));
    const claimed = await queue.poll('h1', 5);
    expect(claimed).toMatchObject({ id: 'c1', op: 'provision', idempotencyToken: 'tok-1' });
  });

  it('fails a stale lifecycle claim with host_timeout, only past max(TTL, deadline + margin), instead of requeueing it', async () => {
    const wheres: unknown[] = [];
    const set = vi.fn(() => ({ where: (cond: unknown) => { wheres.push(cond); return chain([]); } }));
    db.update.mockReturnValue({ set });
    db.delete.mockReturnValue(deleteQ());
    db.select.mockReturnValueOnce(selectQ([]));
    await queue.poll('h1', 0);
    expect(set).not.toHaveBeenCalledWith({ state: 'queued', claimedAt: null });
    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({ state: 'failed', errorCode: 'host_timeout' }));
    const stale = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(stale.sql).toContain('"deadline_ms"');
    expect(stale.sql).toContain('greatest(');
    expect(stale.sql).toContain('"op" not in');
    expect(stale.params).toEqual(expect.arrayContaining(['claimed', 60_000, 30_000, 'fast-run.exec', 'tunnel.open']));
  });

  it('never re-delivers a stale exec or terminal claim; it fails it instead', async () => {
    const wheres: unknown[] = [];
    const set = vi.fn(() => ({ where: (cond: unknown) => { wheres.push(cond); return chain([]); } }));
    db.update.mockReturnValue({ set });
    db.delete.mockReturnValue(deleteQ());
    db.select.mockReturnValueOnce(selectQ([]));
    await queue.poll('h1', 0);
    expect(set).toHaveBeenNthCalledWith(2, expect.objectContaining({ state: 'failed', errorCode: 'host_timeout' }));
    const render = (cond: unknown) => new PgDialect().sqlToQuery(cond as SQL);
    const requeue = render(wheres[0]);
    const failed = render(wheres[1]);
    expect(requeue.sql).toContain('"op" not in');
    expect(requeue.params).toEqual(expect.arrayContaining(['fast-run.exec', 'terminal.open']));
    expect(failed.sql).toContain('"op" in');
    expect(failed.params).toEqual(expect.arrayContaining(['fast-run.exec', 'terminal.open']));
  });

  it('sweeps queued commands past deadline plus grace and old finished rows across hosts', async () => {
    const wheres: unknown[] = [];
    const set = vi.fn(() => ({ where: (cond: unknown) => { wheres.push(cond); return chain([]); } }));
    db.update.mockReturnValue({ set });
    const deleted: unknown[] = [];
    db.delete.mockReturnValue({ where: (cond: unknown) => (deleted.push(cond), chain([])) });
    await queue.sweepAll();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', errorCode: 'host_timeout', errorMessage: expect.stringContaining('expired') }));
    const expired = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(expired.params).toContain('queued');
    expect(expired.params).toContain(60_000);
    expect(expired.sql).toContain('"deadline_ms"');
    expect(expired.sql).not.toContain('"host_id"');
    const old = new PgDialect().sqlToQuery(deleted[0] as SQL);
    expect(old.params).toEqual(expect.arrayContaining(['done', 'failed']));
    expect(old.sql).not.toContain('"host_id"');
  });

  it('runs the sweep on a timer and stops it on destroy', async () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.spyOn(queue, 'sweepAll').mockResolvedValue(undefined);
      queue.onModuleInit();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      queue.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queues a failed command with a fresh deadline clock so the retry is not expired', async () => {
    const stale = commandRow({ state: 'failed', createdAt: new Date('2020-01-01T00:00:00Z'), deadlineMs: 1000 });
    db.insert.mockReturnValue(insertQ([]));
    db.select.mockReturnValueOnce(selectQ([stale]));
    const set = vi.fn(() => ({ where: () => chain([]) }));
    db.update.mockReturnValue({ set });
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'done', result: 1 })]));
    await queue.execute('h1', 'provision', {}, 'tok-1');
    const patch = (set.mock.calls[0] as unknown as [{ state: string; createdAt: Date }])[0];
    expect(patch.state).toBe('queued');
    expect(Date.now() - patch.createdAt.getTime()).toBeLessThan(5000);
  });

  it('surfaces an expired command to its awaiter as a host_timeout failure', async () => {
    db.insert.mockReturnValueOnce(insertQ([commandRow()]));
    db.select.mockReturnValueOnce(selectQ([commandRow()]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'failed', errorCode: 'host_timeout', errorMessage: 'Command expired before a host picked it up' })]));
    await expect(queue.execute('h1', 'status', {}, 'tok-1')).rejects.toMatchObject({ code: 'host_timeout', message: expect.stringContaining('expired') });
  });

  it('refuses a result posted for another host', async () => {
    db.select.mockReturnValueOnce(selectQ([commandRow({ hostId: 'h1' })]));
    await expect(queue.recordResult('h2', 'c1', { ok: true })).rejects.toMatchObject({ response: { code: 'host_mismatch' } });
  });

  describe('snapshot.create results', () => {
    const capture = commandRow({ id: 'cap1', op: 'snapshot.create', state: 'claimed' });
    const failedSet = () => {
      const set = { set: vi.fn(() => ({ where: () => chain([]) })) };
      db.update.mockReturnValueOnce(set);
      return set;
    };

    it('accepts a generation bound to this command and not yet recorded', async () => {
      db.select
        .mockReturnValueOnce(selectQ([capture]))
        .mockReturnValueOnce(selectQ([{ commandId: 'cap1' }]))
        .mockReturnValueOnce(selectQ([]))
        .mockReturnValueOnce(selectQ([]));
      const set = { set: vi.fn(() => ({ where: () => chain([]) })) };
      db.update.mockReturnValueOnce(set);
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'gen-1' } })).resolves.toEqual({ accepted: true });
      expect(set.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'done' }));
    });

    it('fails the command when the generation was never written by it', async () => {
      db.select.mockReturnValueOnce(selectQ([capture])).mockReturnValueOnce(selectQ([]));
      const set = failedSet();
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'made-up' } })).rejects.toMatchObject({ response: { code: 'generation_rejected' } });
      expect(set.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', errorCode: 'generation_rejected' }));
    });

    it('fails the command when the id is bound to another command', async () => {
      db.select.mockReturnValueOnce(selectQ([capture])).mockReturnValueOnce(selectQ([{ commandId: 'other' }])).mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([]));
      failedSet();
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'gen-of-other' } })).rejects.toMatchObject({ response: { code: 'generation_rejected' } });
    });

    it('fails the command when a snapshot or template already records the id', async () => {
      db.select.mockReturnValueOnce(selectQ([capture])).mockReturnValueOnce(selectQ([{ commandId: 'cap1' }])).mockReturnValueOnce(selectQ([{ id: 's1' }]));
      failedSet();
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'recorded' } })).rejects.toMatchObject({ response: { code: 'generation_rejected' } });
      db.select.mockReturnValueOnce(selectQ([capture])).mockReturnValueOnce(selectQ([{ commandId: 'cap1' }])).mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([{ id: 't1' }]));
      failedSet();
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'template-gen' } })).rejects.toMatchObject({ response: { code: 'generation_rejected' } });
    });

    it('does not rewrite the outcome of a finished command on a retried post, and logs it', async () => {
      const warn = vi.spyOn((queue as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      db.select.mockReturnValueOnce(selectQ([{ ...capture, state: 'done' }]));
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'x' } })).resolves.toEqual({ accepted: true });
      expect(db.update).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignored result retry'));
    });

    it('only fails a capture that is still claimed', async () => {
      db.select.mockReturnValueOnce(selectQ([capture])).mockReturnValueOnce(selectQ([]));
      let where: unknown;
      db.update.mockReturnValueOnce({ set: () => ({ where: (cond: unknown) => ((where = cond), chain([])) }) });
      await expect(queue.recordResult('h1', 'cap1', { ok: true, data: { snapshotId: 'made-up' } })).rejects.toBeDefined();
      const rendered = new PgDialect().sqlToQuery(where as SQL);
      expect(rendered.params).toEqual(expect.arrayContaining(['cap1', 'claimed']));
    });
  });

  it('only records a result for a still-claimed command and ignores a racing post', async () => {
    const claimed = commandRow({ state: 'claimed' });
    let where: unknown;
    db.select.mockReturnValueOnce(selectQ([claimed]));
    db.update.mockReturnValueOnce({ set: () => ({ where: (cond: unknown) => ((where = cond), { returning: () => Promise.resolve([]) }) }) });
    const warn = vi.spyOn((queue as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    await expect(queue.recordResult('h1', 'c1', { ok: true })).resolves.toEqual({ accepted: true });
    expect(new PgDialect().sqlToQuery(where as SQL).params).toEqual(expect.arrayContaining(['c1', 'claimed']));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer claimed'));
  });

  it('records a failed result with the host error code', async () => {
    db.select.mockReturnValueOnce(selectQ([commandRow()]));
    const set = { set: vi.fn(() => ({ where: () => chain([]) })) };
    db.update.mockReturnValueOnce(set);
    await expect(queue.recordResult('h1', 'c1', { ok: false, code: 'host_error', message: 'boot failed' })).resolves.toEqual({
      accepted: true,
    });
    expect(set.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', errorCode: 'host_error' }));
  });

  it('re-uses the existing command for a retried token instead of running twice', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue([]);
    db.insert.mockReturnValueOnce({ values: () => ({ onConflictDoNothing }) });
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'queued' })]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'done', result: { ip: '10.0.0.2' } })]));
    await expect(queue.execute('h1', 'provision', { dockId: 'd1' }, 'tok-1')).resolves.toEqual({ ip: '10.0.0.2' });
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('surfaces a host failure to the caller', async () => {
    db.insert.mockReturnValue(insertQ([]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'queued' })]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'failed', errorCode: 'host_error', errorMessage: 'docker run failed' })]));
    await expect(queue.execute('h1', 'provision', {}, 'tok-1')).rejects.toThrow(/docker run failed/);
  });

  it('fails closed when the host never reports a result', async () => {
    db.insert.mockReturnValue(insertQ([]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ state: 'queued', deadlineMs: 1 })]));
    db.select.mockReturnValue(selectQ([commandRow({ state: 'claimed', deadlineMs: 1 })]));
    await expect(queue.execute('h1', 'provision', {}, 'tok-1')).rejects.toMatchObject({ code: 'host_timeout' });
  });

  it('queues and awaits a new command when the token is unseen', async () => {
    db.insert.mockReturnValueOnce(insertQ([commandRow({ id: 'c9', deadlineMs: 1000 })]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ id: 'c9', state: 'queued', deadlineMs: 1000 })]));
    db.select.mockReturnValueOnce(selectQ([commandRow({ id: 'c9', state: 'done', result: { ip: '10.0.0.9' } })]));
    await expect(queue.execute('h1', 'status', {}, 'tok-9')).resolves.toEqual({ ip: '10.0.0.9' });
    expect(db.insert).toHaveBeenCalled();
  });
});
