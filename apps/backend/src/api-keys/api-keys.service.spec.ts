import { HttpStatus } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { hashToken } from '../crypto/tokens';
import { vi, type Mock } from 'vitest';

type Row = Record<string, unknown>;

function mockSelectRows(db: { select: Mock }, rows: Row[]) {
  // Array with chain methods: `await …where(…)` resolves rows directly
  // (Drizzle queries are thenable) while `.limit()`/`.orderBy()` also work.
  const end = Object.assign([...rows], {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
  });
  const where = vi.fn().mockReturnValue(end);
  const from = vi.fn().mockReturnValue({ where });
  (db.select as Mock).mockReturnValue({ from });
  return { from, where };
}

function mockUpdate(db: { update: Mock }) {
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn().mockReturnValue({ where });
  (db.update as Mock).mockReturnValue({ set });
  return { set, where };
}

function keyRow(overrides: Row = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u1',
    name: 'ci',
    keyHash: 'hash',
    keyPrefix: 'abcd1234',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ApiKeysService', () => {
  let db: { select: Mock; insert: Mock; update: Mock };
  let limits: { hit: Mock };
  let service: ApiKeysService;

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    service = new ApiKeysService(db as never, limits as never);
  });

  describe('create', () => {
    it('returns raw secret once and stores only its hash', async () => {
      mockSelectRows(db, []);
      const returning = vi.fn().mockResolvedValue([keyRow()]);
      (db.insert as Mock).mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) });
      const created = await service.create('u1', '  ci  ');
      expect(created.apiKey.startsWith('dock_')).toBe(true);
      const values = (db.insert as Mock).mock.results[0].value.values.mock.calls[0][0];
      expect(values.keyPrefix).toBe(created.apiKey.slice('dock_'.length, 'dock_'.length + 8));
      expect(values.name).toBe('ci');
      expect(values.keyHash).toBe(hashToken(created.apiKey));
      expect(values.keyHash).not.toBe(created.apiKey);
      expect(limits.hit).toHaveBeenCalledWith('rl:apikey:u1', 10, 3600);
    });

    it('rejects blank and overlong names without touching the limiter', async () => {
      for (const name of ['', '   ', 'x'.repeat(101)]) {
        await expect(service.create('u1', name)).rejects.toMatchObject({
          status: HttpStatus.BAD_REQUEST,
          response: { code: 'validation_error' },
        });
      }
      expect(limits.hit).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects past expiry without creating', async () => {
      await expect(service.create('u1', 'ci', new Date(Date.now() - 1000))).rejects.toMatchObject({
        response: { code: 'validation_error' },
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('maps rate limit exhaustion to 429', async () => {
      limits.hit.mockResolvedValue({ allowed: false, count: 11 });
      await expect(service.create('u1', 'ci')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: { code: 'rate_limited' },
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('caps active keys at 20 with api_key_limit_reached', async () => {
      mockSelectRows(
        db,
        Array.from({ length: 20 }, (_, i) => ({ id: `k${i}` })),
      );
      await expect(service.create('u1', 'ci')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { code: 'api_key_limit_reached' },
      });
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns metadata without secrets or hashes', async () => {
      mockSelectRows(db, [keyRow(), keyRow({ id: '22222222-2222-4222-8222-222222222222' })]);
      const rows = await service.list('u1');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).not.toHaveProperty('apiKey');
        expect(row).not.toHaveProperty('keyHash');
      }
      expect(rows[0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', name: 'ci' });
    });
  });

  describe('revoke', () => {
    const id = '11111111-1111-4111-8111-111111111111';

    it('revokes an owned key', async () => {
      mockSelectRows(db, [{ id }]);
      const { set } = mockUpdate(db);
      await expect(service.revoke('u1', id)).resolves.toEqual({ revoked: true });
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
    });

    it('returns 404 for unknown, foreign, or malformed ids', async () => {
      mockSelectRows(db, []);
      for (const bad of ['33333333-3333-4333-8333-333333333333', 'not-a-uuid']) {
        await expect(service.revoke('u1', bad)).rejects.toMatchObject({
          status: HttpStatus.NOT_FOUND,
          response: { code: 'api_key_not_found' },
        });
      }
    });
  });
});
