import { vi } from 'vitest';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import {
  ConfirmRequiredException,
  RETENTION_CONFIRM_PHRASE,
  RetentionService,
  SessionRequiredException,
  TemplatesBlockedException,
} from './retention.service';

describe('RetentionService', () => {
  let db: any;
  let orgs: any;
  let service: RetentionService;
  let provider: any;
  const orgId = '11111111-1111-4111-8111-111111111111';
  const owner = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };
  const keyCaller = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: false };

  const selectQ = (rows: any[]) => ({
    from: () => ({
      where: () => {
        const p = Promise.resolve(rows);
        return { limit: () => p, then: p.then.bind(p) };
      },
    }),
  });
  const insertQ = (rows: any[]) => ({
    values: () => ({ returning: () => Promise.resolve(rows), onConflictDoUpdate: () => Promise.resolve(rows) }),
  });

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
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() };
    vi.clearAllMocks();
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'owner' }) };
    provider = { deleteBacking: vi.fn().mockResolvedValue(undefined) };
    service = new RetentionService(db as never, orgs as never, { get: vi.fn().mockReturnValue(provider) } as never);
  });

  it('reads the switch for members, defaulting to off', async () => {
    db.select.mockReturnValueOnce(selectQ([{ organizationId: orgId, zdrEnabled: true }]));
    await expect(service.getPolicy('u1', orgId)).resolves.toEqual({ enabled: true });
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.getPolicy('u1', orgId)).resolves.toEqual({ enabled: false });
  });

  it('hides the org from non-members on read', async () => {
    orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const err = await catchErr(service.getPolicy('stranger', orgId));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'organization_not_found' });
  });

  it('refuses service-key writes with session_required without touching membership', async () => {
    const err = await catchErr(service.updatePolicy(keyCaller as never, orgId, true, RETENTION_CONFIRM_PHRASE));
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'session_required' });
    expect(orgs.requireMembership).not.toHaveBeenCalled();
    expect(new SessionRequiredException().getStatus()).toBe(403);
  });

  it('requires the exact phrase to enable', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const err = await catchErr(service.updatePolicy(owner as never, orgId, true, 'please delete'));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'confirm_required' });
    expect(new ConfirmRequiredException().getStatus()).toBe(400);
  });

  it('requires owner role for writes', async () => {
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
    const err = await catchErr(service.updatePolicy(owner as never, orgId, false));
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'forbidden' });
  });

  it('disables without a phrase', async () => {
    db.insert.mockReturnValueOnce(insertQ([]));
    await expect(service.updatePolicy(owner as never, orgId, false)).resolves.toEqual({ enabled: false });
  });

  it('enable queues archived docks and purges templates', async () => {
    db.select.mockReturnValueOnce(selectQ([])); // currently off
    const tx: any = { execute: vi.fn().mockResolvedValue([]) };
    tx.select = vi.fn()
      .mockReturnValueOnce(selectQ([{ id: 'ws-1' }])) // workspaces
      .mockReturnValueOnce(selectQ([{ id: 'dock-1' }])) // archived docks
      .mockReturnValueOnce(selectQ([
        { id: 's1', storeSnapshotId: 'g1' },
        { id: 's2', storeSnapshotId: 'g2' },
        { id: 's3', storeSnapshotId: 'g3' },
      ])) // dock snapshots
      .mockReturnValueOnce(selectQ([{ snapshotRef: null, storeSnapshotId: 'g2' }])) // templates of other orgs
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'g3' }])) // other snapshot rows
      .mockReturnValueOnce(selectQ([{ id: 'tpl-1', name: 'web-stack', storeSnapshotId: 'tg1' }])); // templates
    tx.insert = vi.fn()
      .mockReturnValueOnce(insertQ([])) // policy upsert
      .mockReturnValueOnce(insertQ([{ id: 'op-1' }])) // dock op
      .mockReturnValueOnce(insertQ([{ id: 'op-2' }])); // template op
    tx.update = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) });
    tx.delete = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(
      service.updatePolicy(owner as never, orgId, true, RETENTION_CONFIRM_PHRASE),
    ).resolves.toEqual({ enabled: true });
    expect(tx.delete).toHaveBeenCalledTimes(3); // snapshots + dock + template
    expect(provider.deleteBacking.mock.calls).toEqual([['g1'], ['tg1']]);
    expect(new TemplatesBlockedException().getStatus()).toBe(403);
  });

  it('already-enabled returns on without a phrase', async () => {
    db.select.mockReturnValueOnce(selectQ([{ organizationId: orgId, zdrEnabled: true }]));
    await expect(service.updatePolicy(owner as never, orgId, true)).resolves.toEqual({ enabled: true });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('disable is future-only: accepted deletions are untouched', async () => {
    db.insert.mockReturnValueOnce(insertQ([]));
    await expect(service.updatePolicy(owner as never, orgId, false)).resolves.toEqual({ enabled: false });
    expect(db.delete).not.toHaveBeenCalled();
  });
});
