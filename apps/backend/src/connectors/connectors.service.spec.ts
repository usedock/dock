import { ForbiddenException } from '@nestjs/common';
import { vi, type Mock } from 'vitest';
import { openValue } from '../environments/secrets';
import { WorkspaceNotFoundException } from '../workspaces/workspaces.service';
import { ConnectorNotConnectedException, ConnectorNotFoundException, ConnectorsService } from './connectors.service';
import type { ConnectorCredential } from './connector-kinds';

type Row = Record<string, unknown>;

const KEY_HEX = 'ab'.repeat(32);
const KEY = Buffer.from(KEY_HEX, 'hex');
const WS = { id: 'w1', organizationId: 'o1' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function selectQ(rows: Row[]) {
  const end = Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(end) }) };
}

describe('ConnectorsService', () => {
  let db: { select: Mock; insert: Mock; delete: Mock; update: Mock };
  let orgs: { requireMembership: Mock };
  let workspaces: { getById: Mock };
  let fetchFn: Mock;
  let config: Record<string, string>;
  let service: ConnectorsService;

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), update: vi.fn() };
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    workspaces = { getById: vi.fn().mockResolvedValue(WS) };
    fetchFn = vi.fn();
    config = { SECRETS_ENCRYPTION_KEY: KEY_HEX };
    const cfg = { getOrThrow: (k: string) => config[k], get: (k: string) => config[k] };
    service = new ConnectorsService(db as never, orgs as never, workspaces as never, cfg as never, { fetchFn: fetchFn as never });
  });

  function mockUpsert() {
    const returning = vi.fn().mockImplementation(async () => [{ kind: 'linear', status: 'connected', accountLabel: 'Acme', scopes: [], updatedAt: new Date(), credentials: 'SEALED' }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    db.insert.mockReturnValue({ values });
    return { values, onConflictDoUpdate };
  }

  describe('list', () => {
    it('reports every tool plus github and model-keys as read-only entries, without credentials', async () => {
      db.select
        .mockReturnValueOnce(selectQ([{ kind: 'linear', status: 'connected', accountLabel: 'Acme', scopes: ['read'], credentials: { iv: 'i', tag: 't', data: 'SECRET-BLOB' }, updatedAt: new Date('2026-01-01') }]))
        .mockReturnValueOnce(selectQ([{ updatedAt: new Date('2026-02-01') }]))
        .mockReturnValueOnce(selectQ([{ provider: 'openai', updatedAt: new Date('2026-03-01') }, { provider: 'anthropic', updatedAt: new Date('2026-01-01') }]));
      config.LINEAR_CLIENT_ID = 'x';
      config.LINEAR_CLIENT_SECRET = 'y';
      const out = await service.list('u1', 'w1');
      expect(out.map((c) => [c.kind, c.status])).toEqual([
        ['figma', 'not_connected'],
        ['linear', 'connected'],
        ['slack', 'not_connected'],
        ['sentry', 'not_connected'],
        ['github', 'connected'],
        ['model-keys', 'connected'],
      ]);
      expect(out.find((c) => c.kind === 'linear')).toMatchObject({ accountLabel: 'Acme', oauthAvailable: true, readOnly: false });
      expect(out.find((c) => c.kind === 'figma')?.oauthAvailable).toBe(false);
      expect(out.find((c) => c.kind === 'model-keys')).toMatchObject({ scopes: ['anthropic', 'openai'], readOnly: true });
      expect(JSON.stringify(out)).not.toContain('SECRET-BLOB');
      expect(orgs.requireMembership).not.toHaveBeenCalledWith('o1', 'u1', 'admin');
    });

    it('hides workspaces the caller cannot see', async () => {
      workspaces.getById.mockRejectedValue(new WorkspaceNotFoundException());
      await expect(service.list('u1', 'w1')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('connect', () => {
    it('verifies the token with the vendor, seals it, and returns a view without it', async () => {
      fetchFn.mockResolvedValue(json({ data: { viewer: { name: 'Pat', organization: { name: 'Acme' } } } }));
      const { values } = mockUpsert();
      const out = await service.connect('u1', 'w1', 'linear', ' lin_api_secret ');
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://api.linear.app/graphql');
      expect(init.headers.authorization).toBe('lin_api_secret');
      const row = values.mock.calls[0][0];
      expect(row).toMatchObject({ workspaceId: 'w1', kind: 'linear', accountLabel: 'Acme', createdBy: 'u1' });
      expect(JSON.stringify(row.credentials)).not.toContain('lin_api_secret');
      expect(JSON.parse(openValue(KEY, row.credentials))).toEqual({ type: 'token', access: 'lin_api_secret' });
      expect(JSON.stringify(out)).not.toMatch(/lin_api_secret|credentials|SEALED/);
      expect(orgs.requireMembership).toHaveBeenCalledWith('o1', 'u1', 'admin');
    });

    it('uses each vendor identity call (Figma header, Slack auth.test, Sentry organizations)', async () => {
      mockUpsert();
      fetchFn.mockResolvedValueOnce(json({ handle: 'pat' }));
      await service.connect('u1', 'w1', 'figma', 'figd_x');
      expect(fetchFn.mock.calls[0][0]).toBe('https://api.figma.com/v1/me');
      expect(fetchFn.mock.calls[0][1].headers).toEqual({ 'x-figma-token': 'figd_x' });
      fetchFn.mockResolvedValueOnce(json({ ok: true, team: 'Acme' }));
      await service.connect('u1', 'w1', 'slack', 'xoxb-1');
      expect(fetchFn.mock.calls[1][0]).toBe('https://slack.com/api/auth.test');
      expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer xoxb-1');
      fetchFn.mockResolvedValueOnce(json([{ slug: 'acme' }]));
      await service.connect('u1', 'w1', 'sentry', 'sntrys_x');
      expect(fetchFn.mock.calls[2][0]).toBe('https://sentry.io/api/0/organizations/');
    });

    it('refuses a token the vendor rejects and stores nothing', async () => {
      fetchFn.mockResolvedValue(json({}, 401));
      await expect(service.connect('u1', 'w1', 'figma', 'bad')).rejects.toMatchObject({ response: { code: 'connector_token_invalid' } });
      fetchFn.mockResolvedValue(json({ ok: false, error: 'invalid_auth' }));
      await expect(service.connect('u1', 'w1', 'slack', 'bad')).rejects.toMatchObject({ response: { code: 'connector_token_invalid' } });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('reports an unreachable vendor as 502 and stores nothing', async () => {
      fetchFn.mockRejectedValue(new Error('down'));
      await expect(service.connect('u1', 'w1', 'figma', 't')).rejects.toMatchObject({ status: 502, response: { code: 'connector_unreachable' } });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects unknown and read-only kinds and blank tokens before any I/O', async () => {
      for (const kind of ['github', 'model-keys', 'jira']) {
        await expect(service.connect('u1', 'w1', kind, 't')).rejects.toMatchObject({ status: 400 });
      }
      await expect(service.connect('u1', 'w1', 'linear', '  ')).rejects.toMatchObject({ status: 400 });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(workspaces.getById).not.toHaveBeenCalled();
    });

    it('lets only admins connect', async () => {
      orgs.requireMembership.mockRejectedValue(new ForbiddenException());
      await expect(service.connect('u1', 'w1', 'linear', 't')).rejects.toBeInstanceOf(ForbiddenException);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('deletes the connection as an admin, and 404s when there is none', async () => {
      db.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([{ id: 'c1' }]) }) });
      await expect(service.disconnect('u1', 'w1', 'slack')).resolves.toEqual({ kind: 'slack', status: 'not_connected' });
      expect(orgs.requireMembership).toHaveBeenCalledWith('o1', 'u1', 'admin');
      db.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([]) }) });
      await expect(service.disconnect('u1', 'w1', 'slack')).rejects.toBeInstanceOf(ConnectorNotFoundException);
    });

    it('refuses members', async () => {
      orgs.requireMembership.mockRejectedValue(new ForbiddenException());
      await expect(service.disconnect('u1', 'w1', 'slack')).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('assertConnected', () => {
    it('accepts connected kinds, dedupes, and names the missing ones', async () => {
      db.select.mockReturnValue(selectQ([{ kind: 'linear', status: 'connected' }, { kind: 'slack', status: 'reauth_required' }]));
      await expect(service.assertConnected('w1', ['linear', 'linear'])).resolves.toEqual(['linear']);
      await expect(service.assertConnected('w1', ['linear', 'slack', 'figma'])).rejects.toMatchObject({ response: { code: 'connector_not_connected', message: expect.stringContaining('slack, figma') } });
      await expect(service.assertConnected('w1', ['jira'])).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('accessFor', () => {
    const sealedRow = async (cred: ConnectorCredential, status = 'connected') => {
      const { sealValue } = await import('../environments/secrets');
      return { id: 'c1', kind: 'linear', status, credentials: sealValue(KEY, JSON.stringify(cred)) };
    };

    it('opens the credential and returns it', async () => {
      db.select.mockReturnValue(selectQ([await sealedRow({ type: 'token', access: 'tok' })]));
      await expect(service.accessFor('w1', 'linear')).resolves.toEqual({ type: 'token', access: 'tok' });
    });

    it('refuses a missing or re-auth-required connection', async () => {
      db.select.mockReturnValueOnce(selectQ([]));
      await expect(service.accessFor('w1', 'linear')).rejects.toBeInstanceOf(ConnectorNotConnectedException);
      db.select.mockReturnValueOnce(selectQ([await sealedRow({ type: 'token', access: 't' }, 'reauth_required')]));
      await expect(service.accessFor('w1', 'linear')).rejects.toBeInstanceOf(ConnectorNotConnectedException);
    });

    const lockedTx = (rows: Row[]) => {
      const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      const tx = { select: vi.fn().mockReturnValue({ from: () => ({ where: () => ({ for: vi.fn().mockResolvedValue(rows) }) }) }), update: vi.fn().mockReturnValue({ set }) };
      (db as Record<string, unknown>).transaction = vi.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
      return { tx, set };
    };

    it('refreshes an expiring OAuth token under a row lock and stores the new one sealed', async () => {
      config.LINEAR_CLIENT_ID = 'cid';
      config.LINEAR_CLIENT_SECRET = 'cs';
      const expiring = await sealedRow({ type: 'oauth', access: 'old', refresh: 'rt', expiresAt: Date.now() - 1000 });
      db.select.mockReturnValue(selectQ([expiring]));
      const { set } = lockedTx([expiring]);
      fetchFn.mockResolvedValue(json({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }));
      const out = await service.accessFor('w1', 'linear');
      expect(out).toMatchObject({ access: 'new', refresh: 'rt2' });
      expect(JSON.parse(openValue(KEY, set.mock.calls[0][0].credentials)).access).toBe('new');
    });

    it('reuses a token another call refreshed while this one waited for the lock, spending the refresh token once', async () => {
      config.LINEAR_CLIENT_ID = 'cid';
      config.LINEAR_CLIENT_SECRET = 'cs';
      db.select.mockReturnValue(selectQ([await sealedRow({ type: 'oauth', access: 'old', refresh: 'rt', expiresAt: Date.now() - 1000 })]));
      const { tx } = lockedTx([await sealedRow({ type: 'oauth', access: 'new', refresh: 'rt2', expiresAt: Date.now() + 3600_000 })]);
      await expect(service.accessFor('w1', 'linear')).resolves.toMatchObject({ access: 'new' });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('marks the connection re-auth-required when the refresh fails', async () => {
      config.LINEAR_CLIENT_ID = 'cid';
      config.LINEAR_CLIENT_SECRET = 'cs';
      const expiring = await sealedRow({ type: 'oauth', access: 'old', refresh: 'rt', expiresAt: Date.now() - 1000 });
      db.select.mockReturnValue(selectQ([expiring]));
      const { set } = lockedTx([expiring]);
      fetchFn.mockResolvedValue(json({ error: 'invalid_grant' }, 400));
      await expect(service.accessFor('w1', 'linear')).rejects.toBeInstanceOf(ConnectorNotConnectedException);
      expect(set.mock.calls[0][0]).toMatchObject({ status: 'reauth_required' });
    });
  });
});
