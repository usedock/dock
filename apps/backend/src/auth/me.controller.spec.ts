import { vi } from 'vitest';
import { MeController } from './me.controller';

describe('MeController', () => {
  const db = {
    selectDistinct: () => ({ from: () => ({ where: () => Promise.resolve([{ provider: 'credential' }]) }) }),
  };
  const config = { get: (key: string) => (key === 'INSTANCE_ADMIN_EMAILS' ? 'ops@example.com' : undefined) };
  const controller = new MeController(db as never, config as never);
  const user = (email: string) => ({ id: 'u1', email, emailVerified: true });

  it('flags instance admins so the dashboard can show admin views', async () => {
    expect(await controller.getMine(user('ops@example.com'))).toMatchObject({ providers: ['credential'], instanceAdmin: true });
    expect(await controller.getMine(user('member@example.com'))).toMatchObject({ instanceAdmin: false });
    expect(await controller.getMine({ ...user('ops@example.com'), emailVerified: false })).toMatchObject({ instanceAdmin: false });
  });

  describe('removeConnection', () => {
    function withAccounts(rows: Array<{ provider: string; accountId: string; password: string | null }>) {
      const where = vi.fn().mockResolvedValue(undefined);
      const del = vi.fn(() => ({ where }));
      const tx = { select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve(rows) }) }) }), delete: del };
      const fake = { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
      return { ctl: new MeController(fake as never, config as never), del, where };
    }

    it('deletes only the matching provider account', async () => {
      const { ctl, del, where } = withAccounts([
        { provider: 'github', accountId: 'g1', password: null },
        { provider: 'github', accountId: 'g2', password: null },
      ]);
      expect(await ctl.removeConnection(user('a@example.com'), 'github:g1')).toEqual({ removed: true });
      expect(del).toHaveBeenCalledTimes(1);
      expect(where).toHaveBeenCalledTimes(1);
    });

    it('refuses to remove the last login method', async () => {
      const { ctl, del } = withAccounts([{ provider: 'github', accountId: 'g1', password: null }]);
      await expect(ctl.removeConnection(user('a@example.com'), 'github:g1')).rejects.toMatchObject({ status: 409 });
      expect(del).not.toHaveBeenCalled();
    });

    it('allows removal when a password login remains', async () => {
      const { ctl } = withAccounts([
        { provider: 'github', accountId: 'g1', password: null },
        { provider: 'credential', accountId: 'u1', password: 'hash' },
      ]);
      expect(await ctl.removeConnection(user('a@example.com'), 'github:g1')).toEqual({ removed: true });
    });

    it('does not count a passwordless credential row as a login method', async () => {
      const { ctl } = withAccounts([
        { provider: 'github', accountId: 'g1', password: null },
        { provider: 'credential', accountId: 'u1', password: null },
      ]);
      await expect(ctl.removeConnection(user('a@example.com'), 'github:g1')).rejects.toMatchObject({ status: 409 });
    });
  });
});
