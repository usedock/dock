import { HttpException } from '@nestjs/common';
import { environmentVersions, environments, organizationMembers, organizations, subscriptions, workspaces } from '../database/schema';
import { OrganizationsService, isUniqueViolation } from './organizations.service';
import { vi } from 'vitest';
import { bindDockScope, runInDockScope } from '../auth/dock-scope';

describe('OrganizationsService', () => {
  let db: any;
  let service: OrganizationsService;
  function mockSelectOnce(rows: any[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockResolvedValue(rows);
    // Drizzle builders are thenables: chains awaited without a terminal
    // (limit/orderBy) still resolve rows.
    const where = vi.fn().mockReturnValue({ limit, orderBy, then: (r: any) => Promise.resolve(rows).then(r) });
    const from = vi.fn().mockReturnValue({ where, orderBy, limit });
    db.select.mockReturnValueOnce({ from });
  }

  function mockTx() {
    const calls: Array<{ table: unknown; vals: any }> = [];
    const tx: any = { calls, execute: vi.fn().mockResolvedValue([]), select: db.select };
    tx.insert = vi.fn((table: unknown) => ({
      values: vi.fn((vals: any) => {
        calls.push({ table, vals });
        const id = table === organizations ? 'org-1' : `row-${calls.length}`;
        return {
          returning: vi
            .fn()
            .mockResolvedValue([{ ...vals, id, createdAt: new Date(0), updatedAt: new Date(0) }]),
        };
      }),
    }));
    tx.update = vi.fn(() => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'org-1', ...set }]) })),
      })),
    }));
    db.transaction.mockImplementation(async (fn: any) => fn(tx));
    return tx;
  }

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
    service = new OrganizationsService(db as never);
  });

  it('provisionPersonalOrg writes org, owner membership, and default workspace', async () => {
    const tx = mockTx();
    mockSelectOnce([{ version: 1 }]); // current developer plan
    const org = await service.provisionPersonalOrg(tx as never, {
      userId: 'u1',
      email: 'Ada@Example.com',
    });
    expect(org.slug).toMatch(/^ada-[0-9a-f]{6}$/);
    expect(tx.calls.map((c) => c.table)).toEqual([organizations, organizationMembers, workspaces, environments, environmentVersions, subscriptions]);
    expect(tx.calls[0].vals).toMatchObject({ seats: 5 });
    expect(tx.calls[1].vals).toMatchObject({ userId: 'u1', role: 'owner' });
    expect(tx.calls[2].vals).toMatchObject({ name: 'Default', slug: 'default' });
    expect(tx.calls[3].vals).toMatchObject({ name: 'base', isDefault: true });
    expect(tx.calls[4].vals).toMatchObject({ version: 1, repos: [], envVars: {}, secretFiles: [] });
    expect(tx.calls[5].vals).toMatchObject({ plan: 'developer', planVersion: 1, status: 'active' });
  });

  it.each([
    ['Ada Lovelace', "Ada Lovelace's org"],
    ['  ', "Ada's org"],
    [undefined, "Ada's org"],
  ])('provisionPersonalOrg with name %j names the org %j', async (name, expected) => {
    const tx = mockTx();
    mockSelectOnce([{ version: 1 }]);
    await service.provisionPersonalOrg(tx as never, { userId: 'u1', email: 'Ada@Example.com', name });
    expect(tx.calls[0].vals).toMatchObject({ name: expected });
  });

  it('create derives the slug and provisions a default workspace', async () => {
    mockSelectOnce([]); // slug free
    mockSelectOnce([{ version: 1 }]); // current developer plan
    const tx = mockTx();
    const created = await service.create('u1', { name: 'Acme' });
    expect(tx.calls.map((c) => c.table)).toEqual([organizations, organizationMembers, workspaces, environments, environmentVersions, subscriptions]);
    expect(created.role).toBe('owner');
  });

  it('create retries a taken derived slug once with a suffix', async () => {
    mockSelectOnce([{ id: 'other' }]); // base taken
    mockSelectOnce([]); // suffixed free
    mockSelectOnce([{ version: 1 }]); // current developer plan
    mockTx();
    const created = await service.create('u1', { name: 'Acme' });
    expect(created.slug).toMatch(/^acme-[0-9a-f]{6}$/);
  });

  it('create rejects an explicitly taken slug with slug_taken', async () => {
    mockSelectOnce([{ id: 'other' }]);
    mockTx();
    const err = await catchErr(service.create('u1', { name: 'Acme', slug: 'acme' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'slug_taken' });
  });

  it('create rejects illegal slugs and seats with validation_error', async () => {
    mockTx();
    const badSlug = await catchErr(service.create('u1', { name: 'Acme', slug: 'Bad Slug' }));
    expect(badSlug.status).toBe(400);
    expect(badSlug.body).toMatchObject({ code: 'validation_error' });
    const badSeats = await catchErr(service.create('u1', { name: 'Acme', seats: 0 }));
    expect(badSeats.status).toBe(400);
    expect(badSeats.body).toMatchObject({ code: 'validation_error' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('removeMember refuses to drop the last owner', async () => {
    const owner = { role: 'owner' };
    mockSelectOnce([owner]); // caller admin check
    mockTx();
    mockSelectOnce([owner]); // target row
    mockSelectOnce([owner]); // owner-only recheck
    mockSelectOnce([owner]); // owner count of one
    const err = await catchErr(
      service.removeMember('u1', '11111111-1111-4111-8111-111111111111', 'u1'),
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'cannot_remove_owner' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('removeMember and updateMemberRole serialize the owner-count check inside the org lock', async () => {
    const owner = { role: 'owner' };
    mockSelectOnce([owner]); // caller admin check
    const tx = mockTx();
    mockSelectOnce([owner]); // target row
    mockSelectOnce([owner]); // owner-only recheck
    mockSelectOnce([{ role: 'owner' }, { role: 'owner' }]); // two owners, safe to demote
    tx.update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ userId: 'u1', role: 'admin' }]) })),
      })),
    }));
    const updated = await service.updateMemberRole(
      'u1',
      '11111111-1111-4111-8111-111111111111',
      'u1',
      'admin',
    );
    expect(updated).toMatchObject({ role: 'admin' });
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('non-members read organizations as 404 without an existence oracle', async () => {
    mockSelectOnce([]);
    const err = await catchErr(
      service.getById('stranger', '22222222-2222-4222-8222-222222222222'),
    );
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'organization_not_found' });
  });

  it('members cannot change roles', async () => {
    mockSelectOnce([{ role: 'member' }]);
    const err = await catchErr(
      service.updateMemberRole('u1', '11111111-1111-4111-8111-111111111111', 'u2', 'admin'),
    );
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'forbidden' });
  });

  it('seats cannot drop below members plus pending invitations', async () => {
    mockSelectOnce([{ role: 'owner' }]); // admin check
    mockSelectOnce([{ id: 'org-1', seats: 5 }]); // org row
    mockSelectOnce([{ userId: 'u1' }, { userId: 'u2' }]); // two members
    mockSelectOnce([{ id: 'inv-1' }]); // a pending invitation holds a seat
    mockTx();
    const err = await catchErr(
      service.update('u1', '11111111-1111-4111-8111-111111111111', { seats: 1 }),
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
  });

  it('ensureUserHasOrg provisions once and skips users with orgs', async () => {
    mockSelectOnce([]); // no memberships
    mockSelectOnce([]); // recheck inside tx
    mockSelectOnce([{ id: 'u9', email: 'zed@example.com' }]); // user row
    mockSelectOnce([{ version: 1 }]); // current developer plan
    const tx = mockTx();
    const org = await service.ensureUserHasOrg('u9');
    expect(org).toMatchObject({ id: 'org-1' });
    expect(tx.calls.map((c) => c.table)).toEqual([organizations, organizationMembers, workspaces, environments, environmentVersions, subscriptions]);

    mockSelectOnce([{ organizationId: 'org-1' }]);
    await expect(service.ensureUserHasOrg('u9')).resolves.toBeNull();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('listMine backfills legacy users then returns owned orgs with roles', async () => {
    mockSelectOnce([]); // ensureUserHasOrg check
    mockSelectOnce([]); // tx recheck
    mockSelectOnce([{ id: 'u9', email: 'zed@example.com' }]); // tx user row
    mockSelectOnce([{ version: 1 }]); // current developer plan
    mockTx();
    mockSelectOnce([{ organizationId: 'org-1', role: 'owner' }]); // memberships
    mockSelectOnce([{ id: 'org-1', name: "zed's org", slug: 'zed-abc123', seats: 5 }]); // org row
    const rows = await service.listMine('u9');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'org-1', role: 'owner' });
  });

  describe('dock-bound key scope', () => {
    const ORG_A = '11111111-1111-4111-8111-111111111111';
    const ORG_B = '22222222-2222-4222-8222-222222222222';

    it('hides orgs outside the pinned org even for members', async () => {
      await runInDockScope(async () => {
        bindDockScope(ORG_A);
        await expect(service.requireMembership(ORG_B, 'user-1')).rejects.toMatchObject({
          response: { code: 'organization_not_found' },
        });
        expect(db.select).not.toHaveBeenCalled();
      });
    });

    it('still resolves the pinned org', async () => {
      mockSelectOnce([{ organizationId: ORG_A, userId: 'user-1', role: 'member' }]);
      await runInDockScope(async () => {
        bindDockScope(ORG_A);
        await expect(service.requireMembership(ORG_A, 'user-1')).resolves.toMatchObject({ role: 'member' });
      });
    });
  });
});

describe('isUniqueViolation', () => {
  it('matches raw and drizzle-wrapped pg errors', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(new Error('Failed query', { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
