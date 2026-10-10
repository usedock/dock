import { vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  createdRunningDocks,
  AccountClosedException,
  AccountClosureService,
  AccountErasedException,
  CLOSE_GRACE_MS,
  ERASE_CONFIRM_PHRASE,
} from './account-closure.service';

describe('AccountClosureService', () => {
  let db: any;
  let docks: any;
  let mail: any;
  let provider: any;
  let metering: any;
  let sshConnections: any;
  let service: AccountClosureService;

  const orgId = '11111111-1111-4111-8111-111111111111';
  const caller = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };
  const keyCaller = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: false };
  const closedRow = (overrides: Record<string, unknown> = {}) => ({
    userId: 'u1',
    state: 'closed',
    purgeAt: new Date(Date.now() + CLOSE_GRACE_MS),
    purgedAt: null,
    subscriptionCanceledAt: new Date(),
    ...overrides,
  });

  const selectQ = (rows: any[]) => {
    const p = Promise.resolve(rows);
    const orderBy = () => ({ limit: () => p, then: p.then.bind(p) });
    const where = () => ({ orderBy, limit: () => p, then: p.then.bind(p) });
    return { from: () => ({ where, limit: () => p, then: p.then.bind(p) }) };
  };
  const insertQ = (rows: any[]) => ({
    values: () => ({ returning: () => Promise.resolve(rows), onConflictDoUpdate: () => Promise.resolve(rows) }),
  });
  const updateQ = () => ({ set: () => ({ where: () => Promise.resolve([]) }) });
  const deleteQ = () => ({ where: () => Promise.resolve([]) });

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
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() };
    vi.clearAllMocks();
    docks = { stop: vi.fn().mockResolvedValue({ state: 'archived' }) };
    mail = { send: vi.fn().mockResolvedValue({ messageId: 'm1' }) };
    provider = { destroyBacking: vi.fn().mockResolvedValue(undefined), deleteBacking: vi.fn().mockResolvedValue(undefined) };
    sshConnections = { disconnectUser: vi.fn().mockReturnValue(0) };
    metering = { closeWindowsForDock: vi.fn().mockResolvedValue(undefined) };
    db.execute = vi.fn().mockResolvedValue(undefined);
    db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));
    service = new AccountClosureService(db as never, docks as never, mail as never, provider as never, metering as never, sshConnections as never);
  });

  it('refuses close for service keys without touching the database', async () => {
    const err = await catchErr(service.close(keyCaller as never));
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'session_required' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses close on erased accounts with 410', async () => {
    db.select.mockReturnValueOnce(selectQ([{ ...closedRow(), state: 'erased' }]));
    const err = await catchErr(service.close(caller as never));
    expect(err.status).toBe(410);
    expect(err.body).toMatchObject({ code: 'account_closed' });
    expect(new AccountErasedException().getStatus()).toBe(410);
    expect(new AccountClosedException().getStatus()).toBe(403);
  });

  it('closes: archives running docks, revokes credentials, records purge, emails', async () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no existing closure
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // org members
      .mockReturnValueOnce(selectQ([{ id: 'dock-1', state: 'running' }])) // running docks created by the user
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // solo org workspaces
      .mockReturnValueOnce(selectQ([{ id: 'dock-1' }, { id: 'dock-2' }])); // every runnable dock there, incl. foreign-created
    db.update.mockReturnValue(updateQ());
    db.delete.mockReturnValue(deleteQ());
    db.insert.mockReturnValueOnce(insertQ([{ userId: 'u1', state: 'closed' }]));
    const res = await service.close(caller as never);
    expect(res.closed).toBe(true);
    expect(res.purgeAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    expect(docks.stop).toHaveBeenCalledWith('u1', 'dock-1');
    expect(docks.stop).toHaveBeenCalledWith('u1', 'dock-2'); // solo org: created-by may be null or a former member
    expect(docks.stop).toHaveBeenCalledTimes(2);
    expect(db.update).toHaveBeenCalledTimes(1); // api keys only; sessions deleted
    expect(db.delete).toHaveBeenCalledTimes(2); // ssh keys, sessions
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.co', template: 'account-closed' }),
    );
    expect(mail.send.mock.calls[0][0].context.purgeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('close is idempotent while already closed', async () => {
    const purgeAt = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    db.select.mockReturnValueOnce(selectQ([closedRow({ purgeAt })]));
    await expect(service.close(caller as never)).resolves.toEqual({ closed: true, purgeAt });
    expect(docks.stop).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('reopens closed accounts and no-ops when open', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.reopen('u1')).resolves.toEqual({ reopened: false });
    db.select.mockReturnValueOnce(selectQ([closedRow()]));
    db.delete.mockReturnValueOnce(deleteQ());
    await expect(service.reopen('u1')).resolves.toEqual({ reopened: true });
  });

  it('reopen purges first when past due, then returns an empty working account', async () => {
    db.select
      .mockReturnValueOnce(selectQ([closedRow({ purgeAt: new Date(Date.now() - 1000) })])) // closure
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs (purge)
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // sole member
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // workspaces
      .mockReturnValueOnce(selectQ([{ id: 'dock-1' }])) // docks
      .mockReturnValueOnce(selectQ([])) // snapshots
      .mockReturnValueOnce(selectQ([])); // templates
    db.delete.mockReturnValue(deleteQ());
    db.update.mockReturnValue(updateQ());
    await expect(service.reopen('u1')).resolves.toEqual({ reopened: true });
    expect(db.delete).toHaveBeenCalled(); // dock rows, snapshots, templates, closure row
  });

  it('never reopens erased accounts', async () => {
    db.select.mockReturnValueOnce(selectQ([{ ...closedRow(), state: 'erased' }]));
    const err = await catchErr(service.reopen('u1'));
    expect(err.status).toBe(410);
  });

  it('erases only from sessions with the exact phrase', async () => {
    const noSession = await catchErr(service.erase(keyCaller as never, ERASE_CONFIRM_PHRASE));
    expect(noSession.status).toBe(403);
    db.select.mockReturnValueOnce(selectQ([]));
    const badPhrase = await catchErr(service.erase(caller as never, 'delete everything please'));
    expect(badPhrase.status).toBe(400);
    expect(badPhrase.body).toMatchObject({ code: 'confirm_required' });
  });

  it('erases docks and identity, then records erased', async () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure yet
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // sole member
      .mockReturnValueOnce(selectQ([{ id: 'dock-1', state: 'running' }])) // archive: running
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // archive: solo workspaces
      .mockReturnValueOnce(selectQ([{ id: 'dock-1' }])) // archive: solo docks
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // scrub: locked solo re-check
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // scrub: workspaces
      .mockReturnValueOnce(selectQ([{ id: 'dock-1', hostId: 'h1' }])) // scrub: docks
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'gen-1' }, { storeSnapshotId: null }])) // scrub: snapshots
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'gen-t' }])); // scrub: templates
    db.delete.mockReturnValue(deleteQ());
    db.insert.mockReturnValueOnce(insertQ([{ userId: 'u1', state: 'erased' }]));
    const userUpdateSet = vi.fn().mockReturnValue({ where: () => Promise.resolve([]) });
    db.update.mockReturnValueOnce({ set: userUpdateSet });
    await expect(service.erase(caller as never, ERASE_CONFIRM_PHRASE)).resolves.toEqual({ erased: true });
    expect(docks.stop).toHaveBeenCalledWith('u1', 'dock-1');
    expect(sshConnections.disconnectUser).toHaveBeenCalledWith('u1');
    expect(provider.destroyBacking).toHaveBeenCalledWith(expect.objectContaining({ id: 'dock-1' }));
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith('dock-1', undefined, db);
    expect(provider.deleteBacking.mock.calls.map((c: unknown[]) => c[0])).toEqual(['gen-1', 'gen-t']);
    expect(db.delete).toHaveBeenCalled(); // snapshots, docks, templates, keys, tokens, credentials, oauth, profiles
    // Identity scrub: email freed for reuse, no PII left on the users row.
    expect(userUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'erased-u1@erased.invalid',
        name: '',
        image: null,
        emailVerified: false,
        emailVerifiedAt: null,
      }),
    );
  });

  const sharedOrgSelects = () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure yet
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'member' }])); // org members
  };

  it('refuses close for the sole owner of an org with other members', async () => {
    sharedOrgSelects();
    const err = await catchErr(service.close(caller as never));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'sole_owner_of_shared_org' });
    expect(docks.stop).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('refuses erase for the sole owner of an org with other members, deleting nothing', async () => {
    sharedOrgSelects();
    const err = await catchErr(service.erase(caller as never, ERASE_CONFIRM_PHRASE));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'sole_owner_of_shared_org' });
    expect(db.delete).not.toHaveBeenCalled();
    expect(provider.destroyBacking).not.toHaveBeenCalled();
  });

  it('closes for a co-owner and leaves teammates docks alone', async () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure yet
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'owner' }])) // co-owned
      .mockReturnValueOnce(selectQ([])); // no running docks created by u1
    db.update.mockReturnValue(updateQ());
    db.delete.mockReturnValue(deleteQ());
    db.insert.mockReturnValueOnce(insertQ([{}]));
    await expect(service.close(caller as never)).resolves.toMatchObject({ closed: true });
    expect(docks.stop).not.toHaveBeenCalled();
  });

  it('erase removes memberships of shared orgs but never tears down their docks', async () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure yet
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'member' }, { userId: 'u2', role: 'owner' }])) // shared
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'member' }, { userId: 'u2', role: 'owner' }])) // locked check before archiving
      .mockReturnValueOnce(selectQ([])) // no running docks created by u1
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'member' }, { userId: 'u2', role: 'owner' }])); // locked re-check on leave
    db.delete.mockReturnValue(deleteQ());
    db.update.mockReturnValue(updateQ());
    db.insert.mockReturnValueOnce(insertQ([{}]));
    await expect(service.erase(caller as never, ERASE_CONFIRM_PHRASE)).resolves.toEqual({ erased: true });
    expect(provider.destroyBacking).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.execute).toHaveBeenCalledTimes(2); // org lock per shared org, for the check and for the leave
    expect(db.delete).toHaveBeenCalledTimes(6); // members, ssh keys, api keys, sessions, accounts, profiles
  });

  it('erase aborts without leaving the org when a concurrent erase made this user the last owner', async () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure yet
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'owner' }])) // co-owned at pre-check
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u3', role: 'member' }])); // u2 left meanwhile
    db.delete.mockReturnValue(deleteQ());
    const err = await catchErr(service.erase(caller as never, ERASE_CONFIRM_PHRASE));
    expect(err.status).toBe(409);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(docks.stop).not.toHaveBeenCalled(); // 409 lands before any dock is stopped
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it('erase tears down an org as solo when concurrent erases left this user alone in it', async () => {
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure yet
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'owner' }])) // co-owned at pre-check
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // locked check: u2 already gone
      .mockReturnValueOnce(selectQ([])) // no docks created by u1
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // archive: solo workspaces
      .mockReturnValueOnce(selectQ([])) // archive: no runnable docks
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // teardown: locked solo re-check
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // teardown: workspaces
      .mockReturnValueOnce(selectQ([{ id: 'dock-7', hostId: 'h1' }])) // teardown: docks
      .mockReturnValueOnce(selectQ([])) // snapshots
      .mockReturnValueOnce(selectQ([])); // templates
    db.delete.mockReturnValue(deleteQ());
    db.update.mockReturnValue(updateQ());
    db.insert.mockReturnValueOnce(insertQ([{}]));
    await expect(service.erase(caller as never, ERASE_CONFIRM_PHRASE)).resolves.toEqual({ erased: true });
    expect(provider.destroyBacking).toHaveBeenCalledWith(expect.objectContaining({ id: 'dock-7' }));
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith('dock-7', undefined, db);
    expect(db.transaction).toHaveBeenCalledTimes(2); // locked check, then locked teardown; no membership delete for a solo org
    expect(db.delete).toHaveBeenCalledTimes(8); // snapshots, dock, templates, ssh, api, sessions, accounts, profiles
  });

  it('only stops docks matching the created-by predicate (query-level)', async () => {
    const dialect = new PgDialect();
    const { sql, params } = dialect.sqlToQuery(createdRunningDocks('u1') as never);
    expect(sql).toContain('"docks"."created_by" = $1');
    expect(sql).toContain('"docks"."state" in');
    expect(params[0]).toBe('u1');
    // The service must hand that predicate to the first docks query.
    const wheres: unknown[] = [];
    const capture = (rows: any[]) => ({
      from: () => ({
        where: (w: unknown) => {
          wheres.push(w);
          return Promise.resolve(rows);
        },
      }),
    });
    db.select
      .mockReturnValueOnce(selectQ([])) // no closure
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }])) // member orgs
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'owner' }])) // shared
      .mockReturnValueOnce(capture([{ id: 'mine' }])); // created docks query
    db.update.mockReturnValue(updateQ());
    db.delete.mockReturnValue(deleteQ());
    db.insert.mockReturnValueOnce(insertQ([{}]));
    await service.close(caller as never);
    const seen = dialect.sqlToQuery(wheres[0] as never);
    expect({ sql: seen.sql, params: seen.params }).toEqual({ sql, params });
    expect(docks.stop).toHaveBeenCalledTimes(1);
    expect(docks.stop).toHaveBeenCalledWith('u1', 'mine');
  });

  it('logs teardown failures with dock, host and generation ids and keeps going', async () => {
    const errorLog = vi.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    provider.destroyBacking.mockRejectedValue(new Error('host down'));
    provider.deleteBacking.mockRejectedValue(new Error('store down'));
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }])) // locked solo re-check
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }]))
      .mockReturnValueOnce(selectQ([{ id: 'dock-9', hostId: 'host-3' }]))
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'gen-9' }]))
      .mockReturnValueOnce(selectQ([]));
    db.delete.mockReturnValue(deleteQ());
    db.update.mockReturnValue(updateQ());
    await service.purgeDueForUser('u1');
    const lines = errorLog.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('dock=dock-9') && l.includes('host=host-3'))).toBe(true);
    expect(lines.some((l) => l.includes('generation=gen-9') && l.includes('dock=dock-9'))).toBe(true);
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith('dock-9', undefined, db);
  });

  it('runs provider teardown calls after the locked transaction commits', async () => {
    let inTx = false;
    db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      inTx = true;
      try {
        return await cb(db);
      } finally {
        inTx = false;
      }
    });
    const seen: boolean[] = [];
    provider.destroyBacking.mockImplementation(async () => void seen.push(inTx));
    provider.deleteBacking.mockImplementation(async () => void seen.push(inTx));
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }]))
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }]))
      .mockReturnValueOnce(selectQ([{ id: 'dock-1', hostId: 'h1' }]))
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'gen-1' }]))
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'gen-t' }]));
    db.delete.mockReturnValue(deleteQ());
    db.update.mockReturnValue(updateQ());
    await service.purgeDueForUser('u1');
    expect(seen).toEqual([false, false, false]);
  });

  it('skips teardown of an org that gained a member before the lock', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'member' }])); // locked re-check
    db.update.mockReturnValue(updateQ());
    await service.purgeDueForUser('u1');
    expect(provider.destroyBacking).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('guardCheck distinguishes open, closed, and erased', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.guardCheck('u1')).resolves.toBe('ok');
    db.select.mockReturnValueOnce(selectQ([{ ...closedRow(), state: 'erased' }]));
    await expect(service.guardCheck('u1')).resolves.toBe('erased');
    db.select.mockReturnValueOnce(selectQ([closedRow()]));
    await expect(service.guardCheck('u1')).resolves.toBe('closed');
  });

  it('purgeDue sweeps only past-due closures', async () => {
    db.select.mockReturnValueOnce(
      selectQ([
        closedRow({ userId: 'u1', purgeAt: new Date(Date.now() - 1000) }),
        closedRow({ userId: 'u2', purgeAt: new Date(Date.now() + 1000) }),
        { ...closedRow(), userId: 'u3', state: 'erased' },
      ]),
    );
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ userId: 'u1', role: 'owner' }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([]));
    db.delete.mockReturnValue(deleteQ());
    db.update.mockReturnValue(updateQ());
    await expect(service.purgeDue()).resolves.toEqual({ purged: 1 });
  });
});
