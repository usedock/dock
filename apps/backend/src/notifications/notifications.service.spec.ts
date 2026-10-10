import { ForbiddenException, HttpException } from '@nestjs/common';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { NotificationsService, type EmitInput } from './notifications.service';
import { vi } from 'vitest';

const orgId = '11111111-1111-4111-8111-111111111111';
const wsId = '22222222-2222-4222-8222-222222222222';
const dockId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const memberId = '55555555-5555-4555-8555-555555555555';
const owner = { id: ownerId, email: 'o@x.co', emailVerified: true, isInteractive: true };
const member = { id: memberId, email: 'm@x.co', emailVerified: true, isInteractive: true };
const serviceKey = { id: ownerId, email: 'o@x.co', emailVerified: true, isInteractive: false };

const terminal = (rows: unknown[]) => {
  const p = Promise.resolve(rows);
  const t: any = { limit: () => p, orderBy: () => t, then: p.then.bind(p) };
  return t;
};
const selectQ = (rows: unknown[]) => ({
  from: () => ({ where: () => terminal(rows), innerJoin: () => ({ where: () => terminal(rows) }) }),
});
const insertValues = vi.fn();
const insertQ = (rows: unknown[]) => ({
  values: (v: unknown) => (insertValues(v), {
    returning: () => Promise.resolve(rows),
    onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
    onConflictDoUpdate: () => Promise.resolve(rows),
  }),
});
const updateQ = () => ({ set: () => ({ where: () => Promise.resolve([]) }) });
const deleteQ = () => ({ where: () => Promise.resolve([]) });

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: '66666666-6666-4666-8666-666666666666',
  type: 'disk_warning',
  organizationId: orgId,
  workspaceId: wsId,
  dockId,
  dedupeKey: `disk_warning:${dockId}`,
  title: 'Dock disk almost full',
  body: 'dev crossed the disk warning line at 82% of its default disk.',
  linkPath: `/docks/${dockId}`,
  occurredAt: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});
const inboxRow = (overrides: Record<string, unknown> = {}) => ({
  id: '77777777-7777-4777-8777-777777777777',
  eventId: eventRow().id,
  userId: memberId,
  readAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});
const dockRow = (overrides: Record<string, unknown> = {}) => ({
  id: dockId,
  workspaceId: wsId,
  name: 'dev',
  diskGiB: 20,
  state: 'running',
  ...overrides,
});

describe('NotificationsService', () => {
  let db: any;
  let orgs: any;
  let mail: any;
  let config: any;
  let service: NotificationsService;

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
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    vi.clearAllMocks();
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'owner' }) };
    mail = { send: vi.fn().mockResolvedValue({ messageId: 'm1' }) };
    config = { get: vi.fn((key: string) => (key === 'APP_URL' ? 'https://app.usedock.io' : undefined)) };
    service = new NotificationsService(db as never, orgs as never, mail as never, config as never);
    vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('links to APP_URL, else PUBLIC_APP_URL, else the hosted dashboard', () => {
    expect((service as any).appUrl('/docks/d1')).toBe('https://app.usedock.io/docks/d1');
    config.get.mockImplementation((key: string) => (key === 'PUBLIC_APP_URL' ? 'https://dock.example.com' : undefined));
    expect((service as any).appUrl('/docks/d1')).toBe('https://dock.example.com/docks/d1');
    config.get.mockReturnValue(undefined);
    expect((service as any).appUrl('/docks/d1')).toBe('https://dashboard.usedock.io/docks/d1');
  });

  it('reports all six types enabled with email on when no preference rows exist', async () => {
    db.select.mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([]));
    const prefs = await service.getPreferences(memberId, orgId);
    expect(prefs.preferences).toHaveLength(6);
    for (const p of prefs.preferences) expect(p).toMatchObject({ enabled: true, emailEnabled: true });
    expect(prefs.preferences.find((p) => p.type === 'disk_full')).toMatchObject({ audience: 'dock' });
  });

  it('hides the org behind the membership oracle for non-members', async () => {
    orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const err = await catchErr(service.getPreferences(memberId, orgId));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'organization_not_found' });
  });

  it('lets owners manage org switches but refuses members and service keys', async () => {
    db.insert.mockReturnValueOnce(insertQ([]));
    await expect(service.updateOrgPreference(owner as never, orgId, 'disk_warning', false)).resolves.toMatchObject({
      enabled: false,
    });
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
    const denied = await catchErr(service.updateOrgPreference(member as never, orgId, 'disk_warning', false));
    expect(denied.status).toBe(403);
    const keyed = await catchErr(service.updateOrgPreference(serviceKey as never, orgId, 'disk_warning', false));
    expect(keyed.status).toBe(403);
    expect(keyed.body).toMatchObject({ code: 'session_required' });
  });

  it('rejects unknown alert types without touching the database', async () => {
    const err = await catchErr(service.updatePersonalPreference(memberId, 'nope' as never, false));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('lists an empty inbox page for a new member', async () => {
    db.select.mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([{ n: 0 }]));
    await expect(service.listInbox(memberId)).resolves.toEqual({ notifications: [], nextCursor: null, unreadCount: 0 });
  });

  it('pages the inbox newest-first through opaque cursors', async () => {
    const first = { inbox: inboxRow(), event: eventRow() };
    const second = {
      inbox: inboxRow({ id: '88888888-8888-4888-8888-888888888888', createdAt: new Date('2026-08-01T00:00:00Z') }),
      event: eventRow({ id: '99999999-9999-4999-8999-999999999999' }),
    };
    db.select.mockReturnValueOnce(selectQ([first, second])).mockReturnValueOnce(selectQ([{ n: 2 }]));
    const page = await service.listInbox(memberId, undefined, 1);
    expect(page.unreadCount).toBe(2);
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0].id).toBe(first.inbox.id);
    expect(page.notifications[0]).toMatchObject({ read: false, dockId, linkPath: `/docks/${dockId}` });
    expect(page.nextCursor).toBeTruthy();
    db.select.mockReturnValueOnce(selectQ([second])).mockReturnValueOnce(selectQ([{ n: 2 }]));
    const rest = await service.listInbox(memberId, page.nextCursor as string, 1);
    expect(rest.notifications.map((n) => n.id)).toEqual([second.inbox.id]);
    expect(rest.nextCursor).toBeNull();
  });

  it('rejects bad cursors and limits without querying', async () => {
    const badCursor = await catchErr(service.listInbox(memberId, 'not-a-cursor'));
    expect(badCursor.body).toMatchObject({ code: 'validation_error' });
    const badLimit = await catchErr(service.listInbox(memberId, undefined, 0));
    expect(badLimit.body).toMatchObject({ code: 'validation_error' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('marks reads idempotently and hides foreign rows as 404', async () => {
    db.select.mockReturnValueOnce(selectQ([inboxRow()]));
    db.update.mockReturnValueOnce(updateQ());
    await expect(service.markRead(memberId, inboxRow().id)).resolves.toEqual({ id: inboxRow().id, read: true });
    db.select.mockReturnValueOnce(selectQ([inboxRow({ readAt: new Date() })]));
    await expect(service.markRead(memberId, inboxRow().id)).resolves.toEqual({ id: inboxRow().id, read: true });
    expect(db.update).toHaveBeenCalledTimes(1);
    db.select.mockReturnValueOnce(selectQ([]));
    const foreign = await catchErr(service.markRead(ownerId, inboxRow().id));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: 'notification_not_found' });
    const malformed = await catchErr(service.markRead(memberId, 'nope'));
    expect(malformed.body).toMatchObject({ code: 'notification_not_found' });
  });

  it('marks only the caller unread rows read in bulk', async () => {
    const where = vi.fn(() => ({ returning: () => Promise.resolve([{ id: 'a' }, { id: 'b' }]) }));
    const set = vi.fn(() => ({ where }));
    db.update.mockReturnValueOnce({ set });
    await expect(service.markAllRead(memberId)).resolves.toEqual({ updated: 2 });
    expect(set).toHaveBeenCalledWith({ readAt: expect.any(Date) });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('records unknown and dormant types as no-ops without inserting', async () => {
    const base: EmitInput = {
      type: 'disk_warning',
      organizationId: orgId,
      edgeKey: 'k',
      dedupeKey: 'k',
      title: 't',
      body: 'b',
      linkPath: '/docks/x',
      template: 'disk_warning',
      subject: 's',
      context: {},
    };
    await expect(service.emit({ ...base, type: 'nope' as unknown as EmitInput['type'] })).resolves.toBeNull();
    await expect(service.emit({ ...base, type: 'auto_recovered', edgeKey: 'k1', dedupeKey: 'k1' })).resolves.toBeNull();
    await expect(service.emit({ ...base, type: 'held_after_loss', edgeKey: 'k2', dedupeKey: 'k2' })).resolves.toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('treats a lost edge race as a duplicate without a second event', async () => {
    db.insert.mockReturnValueOnce(insertQ([]));
    const out = await service.emit({
      type: 'disk_warning',
      organizationId: orgId,
      edgeKey: 'disk_warning:d1',
      dedupeKey: 'disk_warning:d1',
      title: 't',
      body: 'b',
      linkPath: '/docks/d1',
      template: 'disk_warning',
      subject: 's',
      context: {},
    });
    expect(out).toBeNull();
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('delivers to healthy addresses when one recipient fails', async () => {
    db.insert.mockReturnValueOnce(insertQ([{ edgeKey: 'k' }])).mockReturnValueOnce(insertQ([eventRow()]));
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(
        selectQ([
          { userId: ownerId, email: 'o@x.co', role: 'owner' },
          { userId: memberId, email: 'm@x.co', role: 'member' },
        ]),
      )
      .mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([{}, {}]));
    mail.send.mockRejectedValueOnce(new Error('hard bounce')).mockResolvedValueOnce({ messageId: 'm2' });
    const out = await service.dockStopRefused({ dockId, workspaceId: wsId, dockName: 'dev', at: new Date() });
    expect(out).toEqual({ id: eventRow().id });
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it('still records the event when every email fails', async () => {
    db.insert.mockReturnValueOnce(insertQ([{ edgeKey: 'k' }])).mockReturnValueOnce(insertQ([eventRow()]));
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([{ userId: memberId, email: 'm@x.co', role: 'member' }]))
      .mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([{}]));
    mail.send.mockRejectedValue(new Error('smtp down'));
    await expect(
      service.dockStopRefused({ dockId, workspaceId: wsId, dockName: 'dev', at: new Date() }),
    ).resolves.toEqual({ id: eventRow().id });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
  it('keeps inbox rows while skipping email for personally muted members', async () => {
    db.insert.mockReturnValueOnce(insertQ([{ edgeKey: 'k' }])).mockReturnValueOnce(insertQ([eventRow()]));
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([{ userId: memberId, email: 'm@x.co', role: 'member' }]))
      .mockReturnValueOnce(selectQ([{ userId: memberId, alertType: 'disk_warning', emailEnabled: false }]));
    db.insert.mockReturnValueOnce(insertQ([{}]));
    await service.evaluateDisk(dockId, 17 * 1024 ** 3);
    expect(mail.send).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(3);
  });

  it('returns null instead of throwing when the database fails', async () => {
    db.insert.mockReturnValueOnce({
      values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
    });
    await expect(
      service.emit({
        type: 'disk_warning',
        organizationId: orgId,
        edgeKey: 'k',
        dedupeKey: 'k',
        title: 't',
        body: 'b',
        linkPath: '/x',
        template: 'disk_warning',
        subject: 's',
        context: {},
      }),
    ).resolves.toBeNull();
  });

  it('fires disk_warning once per crossing and re-arms below the hysteresis line', async () => {
    const above = 17 * 1024 ** 3;
    const queueFire = (duplicate: boolean) => {
      db.select.mockReturnValueOnce(selectQ([dockRow()])).mockReturnValueOnce(selectQ([{ organizationId: orgId }]));
      db.insert.mockReturnValueOnce(insertQ(duplicate ? [] : [{ edgeKey: 'k' }]));
      if (duplicate) return service.evaluateDisk(dockId, above);
      db.insert.mockReturnValueOnce(insertQ([eventRow()]));
      db.select.mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([{ userId: memberId, email: 'm@x.co', role: 'member' }])).mockReturnValueOnce(selectQ([]));
      db.insert.mockReturnValueOnce(insertQ([{}]));
      return service.evaluateDisk(dockId, above);
    };
    await expect(queueFire(false)).resolves.toEqual({ id: eventRow().id });
    await expect(queueFire(true)).resolves.toBeNull();
    db.select.mockReturnValueOnce(selectQ([dockRow()])).mockReturnValueOnce(selectQ([{ organizationId: orgId }]));
    db.delete.mockReturnValueOnce(deleteQ()).mockReturnValueOnce(deleteQ());
    await expect(service.evaluateDisk(dockId, 10 * 1024 ** 3)).resolves.toBeNull();
    await expect(queueFire(false)).resolves.toEqual({ id: eventRow().id });
  });

  it('withholds disk_full while snapshots still succeed', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ status: 'completed' }]));
    await expect(service.evaluateDisk(dockId, 21 * 1024 ** 3)).resolves.toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('fires disk_full when out of disk with failing snapshots', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ status: 'failed' }]));
    db.insert.mockReturnValueOnce(insertQ([{ edgeKey: 'k' }])).mockReturnValueOnce(insertQ([eventRow({ type: 'disk_full' })]));
    db.select.mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([{ userId: memberId, email: 'm@x.co', role: 'member' }])).mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([{}]));
    const out = await service.evaluateDisk(dockId, 21 * 1024 ** 3);
    expect(out).toEqual({ id: eventRow().id });
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'disk_full' }));
  });

  it('ignores samples for unknown docks', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.evaluateDisk(dockId, 21 * 1024 ** 3)).resolves.toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
