import { UnauthorizedException } from '@nestjs/common';
import { ALLOW_CLOSED_KEY } from '../common/allow-closed.decorator';
import { ALLOW_DOCK_KEY } from '../common/allow-dock-key.decorator';
import { inDockScope, runInDockScope } from './dock-scope';
import { JwtAuthGuard } from './jwt-auth.guard';
import { vi, type Mock } from 'vitest';

// better-auth ships ESM only; the guard's dependency is stubbed
// at the service boundary instead.
vi.mock('./better-auth/better-auth.service', () => ({ BetterAuthService: vi.fn() }));

describe('JwtAuthGuard', () => {
  let reflector: { getAllAndOverride: Mock };
  let db: { select: Mock; update: Mock };
  let closures: { guardCheck: Mock };
  let betterAuth: { getSessionUser: Mock };
  let guard: JwtAuthGuard;

  const makeContext = (req: object) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    }) as never;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    db = { select: vi.fn(), update: vi.fn() };
    closures = { guardCheck: vi.fn().mockResolvedValue('ok') };
    betterAuth = { getSessionUser: vi.fn().mockResolvedValue(null) };
    guard = new JwtAuthGuard(reflector as never, db as never, closures as never, betterAuth as never);
  });

  it('returns true for @Public() routes without touching auth', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const req = { headers: {} };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(betterAuth.getSessionUser).not.toHaveBeenCalled();
  });

  it('rejects when authorization header is missing and no session cookie', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const req: { headers: Record<string, string | undefined>; user?: unknown } = { headers: {} };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: 'unauthorized' },
    });
    expect(req.user).toBeUndefined();
    expect(betterAuth.getSessionUser).toHaveBeenCalledWith(undefined);
  });

  it('attaches the Better Auth session user when no bearer is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    betterAuth.getSessionUser.mockResolvedValue({ id: 'u9', email: 's@e.c', emailVerified: true, isInteractive: true });
    const req: { headers: Record<string, string | undefined>; user?: unknown } = {
      headers: { cookie: 'better-auth.session_token=abc' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'u9', email: 's@e.c', emailVerified: true, isInteractive: true });
    expect(betterAuth.getSessionUser).toHaveBeenCalledWith('better-auth.session_token=abc');
  });

  it.each([['Token abc.def.ghi'], ['Bearer '], ['']])(
    'rejects malformed header %p without a session',
    async (authorization) => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const req: { headers: Record<string, string | undefined>; user?: unknown } = {
        headers: { authorization },
      };
      await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
        response: { code: 'unauthorized' },
      });
      expect(req.user).toBeUndefined();
    },
  );

  it('rejects bearer tokens that match no API key', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const req: { headers: Record<string, string | undefined>; user?: unknown } = {
      headers: { authorization: 'Bearer expired.token.here' },
    };
    try {
      await guard.canActivate(makeContext(req));
      expect.unreachable('expected UnauthorizedException');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toMatchObject({
        code: 'unauthorized',
        message: 'Invalid or expired token',
      });
    }
    expect(req.user).toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });

  describe('api key fallback', () => {
    const selectOnce = (rows: Record<string, unknown>[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    });
    const mockUpdateOk = () =>
      (db.update as Mock).mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
    const authed = (authorization: string) => {
      reflector.getAllAndOverride.mockReturnValue(false);
      return { headers: { authorization } } as {
        headers: Record<string, string | undefined>;
        user?: unknown;
      };
    };
    const keyRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'key-1',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: null,
      ...overrides,
    });
    const userRow = { id: 'user-1', email: 'a@b.co', emailVerified: true, emailVerifiedAt: null };

    it('authenticates a valid key and stamps lastUsedAt', async () => {
      const req = authed('Bearer dock_validkeymaterial');
      (db.select as Mock)
        .mockImplementationOnce(() => selectOnce([keyRow()]))
        .mockImplementationOnce(() => selectOnce([userRow]));
      mockUpdateOk();
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
      expect(req.user).toEqual({ id: 'user-1', email: 'a@b.co', emailVerified: true, isInteractive: false });
      expect(db.update).toHaveBeenCalled();
    });

    it('reads the authoritative emailVerified flag for API keys, not emailVerifiedAt', async () => {
      const req = authed('Bearer dock_validkeymaterial');
      (db.select as Mock)
        .mockImplementationOnce(() => selectOnce([keyRow()]))
        .mockImplementationOnce(() => selectOnce([{ ...userRow, emailVerified: false, emailVerifiedAt: new Date() }]));
      mockUpdateOk();
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
      expect(req.user).toMatchObject({ emailVerified: false });
    });

    it('rejects unknown, revoked, and expired keys without a user', async () => {
      const cases: Array<[string, Record<string, unknown>[]]> = [
        ['Bearer dock_unknown', []],
        ['Bearer dock_revoked', [keyRow({ revokedAt: new Date() })]],
        ['Bearer dock_expired', [keyRow({ expiresAt: new Date(Date.now() - 1000) })]],
      ];
      for (const [authorization, keys] of cases) {
        db.select.mockReset();
        (db.select as Mock).mockImplementationOnce(() => selectOnce(keys));
        const req = authed(authorization);
        await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
          response: { code: 'unauthorized' },
        });
        expect(req.user).toBeUndefined();
      }
    });

    it('rejects when the key owner is gone', async () => {
      const req = authed('Bearer dock_orphan');
      (db.select as Mock)
        .mockImplementationOnce(() => selectOnce([keyRow()]))
        .mockImplementationOnce(() => selectOnce([]));
      await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
        response: { code: 'unauthorized' },
      });
      expect(req.user).toBeUndefined();
    });

    it('still authenticates when the lastUsedAt write fails', async () => {
      const req = authed('Bearer dock_flakywrite');
      (db.select as Mock)
        .mockImplementationOnce(() => selectOnce([keyRow()]))
        .mockImplementationOnce(() => selectOnce([userRow]));
      (db.update as Mock).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('db down')),
        }),
      });
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
      expect(req.user).toEqual({ id: 'user-1', email: 'a@b.co', emailVerified: true, isInteractive: false });
    });
  });

  describe('dock-bound keys', () => {
    const selectOnce = (rows: Record<string, unknown>[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    });
    const selectJoin = (rows: Record<string, unknown>[]) => ({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        }),
      }),
    });
    const setup = (orgRows: Record<string, unknown>[], allowed: boolean, dockParam = 'dock-1') => {
      reflector.getAllAndOverride.mockImplementation((key: unknown) => (key === ALLOW_DOCK_KEY ? allowed : false));
      (db.select as Mock)
        .mockImplementationOnce(() => selectOnce([{ id: 'key-1', userId: 'user-1', dockId: 'dock-1', revokedAt: null, expiresAt: null }]))
        .mockImplementationOnce(() => selectOnce([{ id: 'user-1', email: 'a@b.co', emailVerifiedAt: new Date() }]))
        .mockImplementationOnce(() => selectJoin(orgRows));
      (db.update as Mock).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) });
      return { headers: { authorization: 'Bearer dock_dockbound' }, params: { id: dockParam } } as { headers: Record<string, string>; params: Record<string, string>; user?: unknown };
    };

    it('marks the user with its dock and org and pins the request scope', async () => {
      const req = setup([{ organizationId: 'org-1' }], true);
      await runInDockScope(async () => {
        await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
        expect(inDockScope('org-1')).toBe(true);
        expect(inDockScope('org-2')).toBe(false);
      });
      expect(req.user).toMatchObject({ id: 'user-1', isInteractive: false, dockId: 'dock-1', dockOrgId: 'org-1' });
    });

    it('rejects routes without @AllowDockKey() with dock_key_forbidden', async () => {
      const req = setup([{ organizationId: 'org-1' }], false);
      await runInDockScope(async () => {
        await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
          response: { code: 'dock_key_forbidden' },
        });
      });
      expect(req.user).toBeUndefined();
    });

    it('rejects an allowed route addressed at another dock', async () => {
      const req = setup([{ organizationId: 'org-1' }], true, 'dock-2');
      await runInDockScope(async () => {
        await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
          response: { code: 'dock_key_forbidden' },
        });
      });
      expect(req.user).toBeUndefined();
    });

    it('rejects when the dock org cannot be resolved', async () => {
      const req = setup([], true);
      await runInDockScope(async () => {
        await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({ response: { code: 'unauthorized' } });
      });
    });

    it('rejects when no request scope is open (fail closed)', async () => {
      const req = setup([{ organizationId: 'org-1' }], true);
      await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({ response: { code: 'unauthorized' } });
    });

    it('lets plain user keys through routes without @AllowDockKey()', async () => {
      reflector.getAllAndOverride.mockImplementation(() => false);
      (db.select as Mock)
        .mockImplementationOnce(() => selectOnce([{ id: 'key-1', userId: 'user-1', dockId: null, revokedAt: null, expiresAt: null }]))
        .mockImplementationOnce(() => selectOnce([{ id: 'user-1', email: 'a@b.co', emailVerifiedAt: new Date() }]));
      (db.update as Mock).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) });
      const req: { headers: Record<string, string>; user?: unknown } = { headers: { authorization: 'Bearer dock_plain' } };
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
      expect(req.user).not.toHaveProperty('dockId');
    });
  });

  describe('closed accounts', () => {
    const session = (): { headers: Record<string, string | undefined>; user?: unknown } => {
      reflector.getAllAndOverride.mockReturnValue(false);
      betterAuth.getSessionUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c', emailVerified: true, isInteractive: true });
      return { headers: { cookie: 'better-auth.session_token=abc' } };
    };

    it('blocks closed accounts with account_closed except @AllowClosed() routes', async () => {
      closures.guardCheck.mockResolvedValue('closed');
      const req = session();
      await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
        response: { code: 'account_closed' },
      });
      expect(req.user).toBeUndefined();
    });

    it('passes closed accounts through @AllowClosed() routes', async () => {
      closures.guardCheck.mockResolvedValue('closed');
      reflector.getAllAndOverride.mockImplementation((key: unknown) => key === ALLOW_CLOSED_KEY);
      betterAuth.getSessionUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c', emailVerified: true, isInteractive: true });
      const req: { headers: Record<string, string | undefined>; user?: unknown } = { headers: { cookie: 'better-auth.session_token=abc' } };
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
      expect(req.user).toMatchObject({ id: 'user-1', isInteractive: true });
    });

    it('returns 410 for erased accounts on every route', async () => {
      closures.guardCheck.mockResolvedValue('erased');
      reflector.getAllAndOverride.mockImplementation((key: unknown) => key === ALLOW_CLOSED_KEY);
      betterAuth.getSessionUser.mockResolvedValue({ id: 'user-1', email: 'a@b.c', emailVerified: true, isInteractive: true });
      const req: { headers: Record<string, string | undefined>; user?: unknown } = { headers: { cookie: 'better-auth.session_token=abc' } };
      await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
        status: 410,
        response: { code: 'account_closed' },
      });
      expect(req.user).toBeUndefined();
    });
  });
});
