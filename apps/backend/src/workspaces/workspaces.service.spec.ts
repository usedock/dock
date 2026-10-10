import { ForbiddenException, HttpException } from '@nestjs/common';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { WorkspaceNotFoundException, WorkspacesService } from './workspaces.service';
import { vi } from 'vitest';

describe('WorkspacesService', () => {
  let db: any;
  let orgs: any;
  let service: WorkspacesService;

  function mockSelectOnce(rows: any[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit, orderBy, then: (r: any) => Promise.resolve(rows).then(r) });
    const from = vi.fn().mockReturnValue({ where, orderBy, limit });
    db.select.mockReturnValueOnce({ from });
  }

  function mockInsertReturning(row: any) {
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([row]) }),
    });
  }

  function mockTx() {
    const tx: any = { execute: vi.fn().mockResolvedValue([]), select: db.select };
    tx.insert = vi.fn((table: unknown) => ({
      values: vi.fn((vals: any) => ({
        returning: vi.fn().mockResolvedValue([{ ...vals, id: 'ws-1' }]),
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
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    service = new WorkspacesService(db as never, orgs as never);
  });

  it('listByOrg returns the org workspaces for members', async () => {
    mockSelectOnce([{ id: 'ws-1', slug: 'default' }]);
    const rows = await service.listByOrg('u1', '11111111-1111-4111-8111-111111111111');
    expect(rows).toHaveLength(1);
    expect(orgs.requireMembership).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'u1',
    );
  });

  it('listByOrg backfills the default workspace for legacy orgs', async () => {
    mockSelectOnce([]);
    mockInsertReturning({ id: 'ws-9', slug: 'default', name: 'Default' });
    const rows = await service.listByOrg('u1', '11111111-1111-4111-8111-111111111111');
    expect(rows).toEqual([{ id: 'ws-9', slug: 'default', name: 'Default' }]);
  });

  it('listByOrg hides org existence from non-members', async () => {
    orgs.requireMembership.mockRejectedValue(new OrganizationNotFoundException());
    const err = await catchErr(service.listByOrg('stranger', '11111111-1111-4111-8111-111111111111'));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'organization_not_found' });
  });

  it('create derives the slug and allows reuse across orgs', async () => {
    mockSelectOnce([]); // per-org slug free
    mockTx();
    const ws = await service.create('u1', '11111111-1111-4111-8111-111111111111', { name: 'Backend' });
    expect(ws).toMatchObject({ slug: 'backend' });
    expect(orgs.requireMembership).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'u1',
      'admin',
    );
  });

  it('create rejects per-org slug collisions and member writes', async () => {
    mockSelectOnce([{ id: 'ws-1' }]);
    mockTx();
    const taken = await catchErr(
      service.create('u1', '11111111-1111-4111-8111-111111111111', { name: 'Backend', slug: 'backend' }),
    );
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'slug_taken' });

    orgs.requireMembership.mockRejectedValue(
      new ForbiddenException({ code: 'forbidden', message: 'Insufficient organization role' }),
    );
    const forbidden = await catchErr(
      service.create('u1', '11111111-1111-4111-8111-111111111111', { name: 'Other' }),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ code: 'forbidden' });
  });

  it('getById maps foreign membership to workspace_not_found', async () => {
    mockSelectOnce([]);
    const missing = await catchErr(service.getById('u1', '33333333-3333-4333-8333-333333333333'));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'workspace_not_found' });

    mockSelectOnce([{ id: 'ws-1', organizationId: 'org-other' }]);
    orgs.requireMembership.mockRejectedValue(new OrganizationNotFoundException());
    const foreign = await catchErr(service.getById('u1', '33333333-3333-4333-8333-333333333333'));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: 'workspace_not_found' });
    expect(foreign.body).not.toMatchObject({ code: 'organization_not_found' });
  });
  it('rename to a taken slug fails with slug_taken', async () => {
    const ws = { id: 'ws-1', organizationId: 'org-1', slug: 'frontend' };
    mockSelectOnce([ws]); // getById load
    mockSelectOnce([{ id: 'ws-2' }]); // collision check
    const err = await catchErr(service.update('u1', '33333333-3333-4333-8333-333333333333', { slug: 'backend' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'slug_taken' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('remove refuses the sole default workspace but deletes others', async () => {
    const only = { id: 'ws-1', organizationId: 'org-1', slug: 'default' };
    mockSelectOnce([only]); // getById load
    mockSelectOnce([{ id: 'ws-1' }]); // sole sibling
    const refused = await catchErr(service.remove('u1', '33333333-3333-4333-8333-333333333333'));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'validation_error' });
    expect(db.delete).not.toHaveBeenCalled();

    mockSelectOnce([only]); // getById load
    mockSelectOnce([{ id: 'ws-1' }, { id: 'ws-2' }]); // siblings exist
    mockSelectOnce([]); // no docks
    db.delete.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    await expect(service.remove('u1', '33333333-3333-4333-8333-333333333333')).resolves.toEqual({
      deleted: true,
    });
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('remove refuses a workspace that still has docks so no machine is orphaned', async () => {
    mockSelectOnce([{ id: 'ws-2', organizationId: 'org-1', slug: 'staging' }]); // getById load
    mockSelectOnce([{ id: 'ws-1' }, { id: 'ws-2' }]); // siblings exist
    mockSelectOnce([{ id: 'dock-1' }]); // a dock remains
    const refused = await catchErr(service.remove('u1', '33333333-3333-4333-8333-333333333333'));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'workspace_not_empty' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('remove refuses the sole workspace even after it is renamed off the default slug', async () => {
    const renamed = { id: 'ws-1', organizationId: 'org-1', slug: 'frontend' };
    mockSelectOnce([renamed]); // getById load
    mockSelectOnce([{ id: 'ws-1' }]); // sole sibling, no 'default' slug left
    const refused = await catchErr(service.remove('u1', '33333333-3333-4333-8333-333333333333'));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'validation_error' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('workspace errors carry the workspace_not_found code', () => {
    expect(new WorkspaceNotFoundException().getResponse()).toMatchObject({
      code: 'workspace_not_found',
    });
  });
});
