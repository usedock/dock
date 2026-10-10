import { NotFoundException } from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { vi } from 'vitest';

describe('ProfilesService', () => {
  let db: any;
  let service: ProfilesService;

  function mockSelectRows(rows: any[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    db.select.mockReturnValue({ from });
  }

  function mockUpdateReturning(rows: any[]) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    db.update.mockReturnValue({ set });
    return { set, where, returning };
  }

  beforeEach(() => {
    db = { select: vi.fn(), update: vi.fn() };
    vi.clearAllMocks();
    service = new ProfilesService(db as never);
  });

  it('getByUserId hit returns profile', async () => {
    const profile = { id: 'p1', userId: 'u1', displayName: 'Ada' };
    mockSelectRows([profile]);
    await expect(service.getByUserId('u1')).resolves.toEqual(profile);
  });

  it('getByUserId miss rejects NotFoundException with code not_found', async () => {
    mockSelectRows([]);
    const err = await service.getByUserId('missing').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ code: 'not_found' });
  });

  it('update hit returns updated row and passes patch plus updatedAt into set', async () => {
    const updated = { id: 'p1', userId: 'u1', displayName: 'Grace' };
    const { set } = mockUpdateReturning([updated]);
    const result = await service.update('u1', { displayName: 'Grace' });
    expect(result).toEqual(updated);
    expect(set).toHaveBeenCalledTimes(1);
    const setArg = set.mock.calls[0][0];
    expect(setArg.displayName).toBe('Grace');
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it('update miss rejects not_found and performs no second write', async () => {
    mockUpdateReturning([]);
    const err = await service.update('missing', { displayName: 'Nobody' }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ code: 'not_found' });
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
