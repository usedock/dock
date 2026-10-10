import { profiles, users } from '../database/schema';
import { UsersService } from './users.service';
import { vi, type Mock } from 'vitest';

describe('UsersService', () => {
  let db: {
    select: Mock;
    insert: Mock;
    update: Mock;
    transaction: Mock;
  };
  let orgs: { provisionPersonalOrg: Mock };
  let service: UsersService;

  function mockSelectRows(rows: Array<Record<string, unknown>>) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    db.select.mockReturnValue({ from });
  }

  function mockTx(userRow: Record<string, unknown>, calls: Array<{ table: unknown; vals: unknown }>) {
    const txInsert = vi.fn((table: unknown) => ({
      values: vi.fn((vals: unknown) => {
        calls.push({ table, vals });
        if (table === users) {
          return { returning: vi.fn().mockResolvedValue([userRow]) };
        }
        return {};
      }),
    }));
    const tx = { insert: txInsert };
    db.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    return { txInsert };
  }

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() };
    vi.clearAllMocks();
    orgs = { provisionPersonalOrg: vi.fn().mockResolvedValue({ id: 'org-1' }) };
    service = new UsersService(db as never, orgs as never);
  });

  it('normalize trims and lowercases', () => {
    expect(service.normalize('  Ada@Example.COM  ')).toBe('ada@example.com');
  });

  it('findByEmail hit returns row and queries select chain', async () => {
    const row = { id: 'u1', email: 'ada@example.com' };
    mockSelectRows([row]);
    await expect(service.findByEmail('  ADA@example.com ')).resolves.toEqual(row);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('findByEmail miss returns null', async () => {
    mockSelectRows([]);
    await expect(service.findByEmail('missing@example.com')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('findById hit returns row, miss returns null', async () => {
    const row = { id: 'u1', email: 'ada@example.com' };
    mockSelectRows([row]);
    await expect(service.findById('u1')).resolves.toEqual(row);
    mockSelectRows([]);
    await expect(service.findById('nope')).resolves.toBeNull();
  });

  it('createWithOrg writes user, profile, and personal org in one transaction', async () => {
    const user = { id: 'u1', email: 'ada@example.com' };
    const calls: Array<{ table: unknown; vals: unknown }> = [];
    mockTx(user, calls);
    const result = await service.createWithOrg('  ADA@Example.COM ');
    expect(result).toEqual(user);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].table).toBe(users);
    expect(calls[0].vals).toMatchObject({ email: 'ada@example.com' });
    expect(calls[1].table).toBe(profiles);
    expect(calls[1].vals).toMatchObject({ userId: 'u1' });
    expect(orgs.provisionPersonalOrg).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      email: 'ada@example.com',
    });
  });

  it('provisioning failure rejects user creation', async () => {
    const user = { id: 'u3', email: 'zed@example.com' };
    const calls: Array<{ table: unknown; vals: unknown }> = [];
    mockTx(user, calls);
    orgs.provisionPersonalOrg.mockRejectedValue(new Error('org down'));
    await expect(service.createWithOrg('zed@example.com')).rejects.toThrow('org down');
  });

  it('provisionBetterAuthUser writes profile, syncs verification, provisions org', async () => {
    let captured: Record<string, unknown> | undefined;
    const where = vi.fn().mockResolvedValue({});
    const set = vi.fn((vals: Record<string, unknown>) => {
      captured = vals;
      return { where };
    });
    const tx = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })) })),
      update: vi.fn(() => ({ set })),
    };
    db.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
    await service.provisionBetterAuthUser({ id: 'u9', email: '  Quinn@Example.COM ', emailVerified: true });
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({ emailVerified: true });
    expect(captured?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(orgs.provisionPersonalOrg).toHaveBeenCalledWith(tx, {
      userId: 'u9',
      email: 'quinn@example.com',
    });
  });

  it('provisionBetterAuthUser skips verification sync when unverified', async () => {
    const tx = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })) })),
      update: vi.fn(),
    };
    db.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
    await service.provisionBetterAuthUser({ id: 'u9', email: 'quinn@example.com', emailVerified: false });
    expect(tx.update).not.toHaveBeenCalled();
    expect(orgs.provisionPersonalOrg).toHaveBeenCalledTimes(1);
  });
});
