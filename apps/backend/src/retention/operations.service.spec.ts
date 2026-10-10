import { HttpException } from '@nestjs/common';
import { OperationNotFoundException, OperationsService } from './operations.service';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { vi } from 'vitest';

describe('OperationsService', () => {
  let db: any;
  let orgs: { requireMembership: ReturnType<typeof vi.fn> };
  let service: OperationsService;
  const orgId = '11111111-1111-4111-8111-111111111111';

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'op-uuid-1',
    displayId: 'op_abc123',
    organizationId: orgId,
    targetType: 'dock',
    targetId: 'dock-1',
    status: 'pending',
    ...overrides,
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
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    vi.clearAllMocks();
    orgs = { requireMembership: vi.fn().mockResolvedValue({}) };
    service = new OperationsService(db as never, orgs as never);
  });

  it('creates a pending operation with an op_ display id', async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
    });
    const values = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([row()]) });
    db.insert.mockReturnValueOnce({ values });
    const op = await service.create(orgId, 'dock', 'dock-1');
    expect(values.mock.calls[0][0]).toMatchObject({ organizationId: orgId, targetType: 'dock', targetId: 'dock-1' });
    expect(op).toMatchObject({ id: 'op_abc123', targetType: 'dock', targetId: 'dock-1', status: 'pending' });
    expect(op.id.startsWith('op_')).toBe(true);
  });

  it('reuses a blocked operation for the same target on retry', async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([row({ status: 'blocked' })]) }) }),
    });
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([row({ status: 'pending' })]) }),
    });
    db.update.mockReturnValueOnce({ set });
    const op = await service.create(orgId, 'dock', 'dock-1');
    expect(op).toMatchObject({ id: 'op_abc123', status: 'pending' });
    expect(set.mock.calls[0][0]).toMatchObject({ status: 'pending' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('completes an operation by display id', async () => {
    db.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([row({ status: 'completed' })]) }),
      }),
    });
    await expect(service.complete('op_abc123')).resolves.toMatchObject({ status: 'completed' });
  });

  const selectReturns = (rows: unknown[]) =>
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) }),
    });

  it('reads an operation by display id for an org member', async () => {
    selectReturns([row()]);
    await expect(service.get('u1', 'op_abc123')).resolves.toMatchObject({ id: 'op_abc123' });
    expect(orgs.requireMembership).toHaveBeenCalledWith(orgId, 'u1');
  });

  it('hides operations from non-members as 404', async () => {
    selectReturns([row()]);
    orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const err = await catchErr(service.get('intruder', 'op_abc123'));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'operation_not_found' });
  });

  it('hides legacy operations without an owning org as 404', async () => {
    selectReturns([row({ organizationId: null })]);
    const err = await catchErr(service.get('u1', 'op_abc123'));
    expect(err.status).toBe(404);
    expect(orgs.requireMembership).not.toHaveBeenCalled();
  });

  it('returns 404 operation_not_found for unknown ids on get and complete', async () => {
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
    });
    const missing = await catchErr(service.get('u1', 'op_nope'));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'operation_not_found' });
    db.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
    });
    const gone = await catchErr(service.complete('op_nope'));
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'operation_not_found' });
    expect(new OperationNotFoundException().getStatus()).toBe(404);
  });
});
