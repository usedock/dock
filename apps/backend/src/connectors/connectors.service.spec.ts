import { ForbiddenException } from '@nestjs/common';
import { vi, type Mock } from 'vitest';
import { openValue, sealValue } from '../environments/secrets';
import { WorkspaceNotFoundException } from '../workspaces/workspaces.service';
import { ConnectorAccountInUseException, ConnectorNotConnectedException, ConnectorNotFoundException, ConnectorsService, deriveCredentialType } from './connectors.service';
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
        .mockReturnValueOnce(selectQ([{ kind: 'linear', status: 'connected', accountLabel: 'Acme', credentialType: 'personal_token', scopes: ['read'], credentials: { iv: 'i', tag: 't', data: 'SECRET-BLOB' }, updatedAt: new Date('2026-01-01') }]))
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
      expect(out.find((c) => c.kind === 'linear')).toMatchObject({ accountLabel: 'Acme', credentialType: 'personal_token', oauthAvailable: true, readOnly: false });
      expect(out.find((c) => c.kind === 'figma')?.credentialType).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
      expect(out.find((c) => c.kind === 'figma')?.oauthAvailable).toBe(false);
      expect(out.find((c) => c.kind === 'model-keys')).toMatchObject({ scopes: ['anthropic', 'openai'], readOnly: true });
      expect(JSON.stringify(out)).not.toContain('SECRET-BLOB');
      expect(orgs.requireMembership).not.toHaveBeenCalledWith('o1', 'u1', 'admin');
    });

    it('lists a legacy row it cannot open without opening it or writing', async () => {
      db.select
        .mockReturnValueOnce(selectQ([{ id: 'a', kind: 'linear', status: 'connected', credentialType: null, scopes: [], credentials: { iv: 'x', tag: 'y', data: 'TAMPERED' }, updatedAt: new Date() }]))
        .mockReturnValueOnce(selectQ([]))
        .mockReturnValueOnce(selectQ([]));
      const out = await service.list('u1', 'w1');
      expect(out.find((c) => c.kind === 'linear')).toMatchObject({ status: 'connected', credentialType: null });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('hides workspaces the caller cannot see', async () => {
      workspaces.getById.mockRejectedValue(new WorkspaceNotFoundException());
      await expect(service.list('u1', 'w1')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('backfillCredentialTypes', () => {
    it('derives and stores the type of rows from before the column existed, skipping rows it cannot open', async () => {
      const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      db.update.mockReturnValue({ set });
      const sealed = (cred: ConnectorCredential) => sealValue(KEY, JSON.stringify(cred));
      db.select.mockReturnValueOnce(
        selectQ([
          { id: 'a', kind: 'linear', credentials: sealed({ type: 'oauth', access: 'a', refresh: 'r', expiresAt: 1 }) },
          { id: 'bad', kind: 'figma', credentials: { iv: 'x', tag: 'y', data: 'TAMPERED' } },
          { id: 'notjson', kind: 'sentry', credentials: sealValue(KEY, 'sntryu_SECRETPLAINTEXT') },
          { id: 'b', kind: 'slack', credentials: sealed({ type: 'token', access: 'xoxb-1' }) },
        ]),
      );
      const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
      await service.backfillCredentialTypes();
      expect(set.mock.calls.map((c) => c[0])).toEqual([{ credentialType: 'oauth' }, { credentialType: 'bot_token' }]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETPLAINTEXT');
    });

    it('never throws out of boot when the query fails', async () => {
      db.select.mockImplementation(() => {
        throw new Error('column "credential_type" does not exist');
      });
      const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
      expect(() => service.onApplicationBootstrap()).not.toThrow();
      await new Promise((r) => setImmediate(r));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Credential type backfill failed'));
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

    it('records the credential type derived from the token', async () => {
      const { values, onConflictDoUpdate } = mockUpsert();
      fetchFn.mockResolvedValue(json({ data: { viewer: { name: 'Pat' } } }));
      await service.connect('u1', 'w1', 'linear', 'lin_api_x');
      expect(values.mock.calls[0][0].credentialType).toBe('personal_token');
      expect(onConflictDoUpdate.mock.calls[0][0].set.credentialType).toBe('personal_token');
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
  describe('webhook routing and Sentry host', () => {
    const rowQ = (rows: Row[]) => selectQ(rows);

    it('records the vendor account and user a webhook routes by when a token is connected', async () => {
      fetchFn.mockResolvedValue(json({ data: { viewer: { id: 'u-lin', name: 'Pat', organization: { id: 'org-9', name: 'Acme' } } } }));
      const { values, onConflictDoUpdate } = mockUpsert();
      await service.connect('u1', 'w1', 'linear', 'lin_api_x');
      expect(values.mock.calls[0][0]).toMatchObject({ externalId: 'org-9', vendorUserId: 'u-lin' });
      // The connecting admin owns the connector's docks, also on reconnect.
      expect(onConflictDoUpdate.mock.calls[0][0].set).toMatchObject({ createdBy: 'u1', externalId: 'org-9' });
    });

    it('stores a validated Sentry region and verifies against it', async () => {
      fetchFn.mockResolvedValue(json([{ slug: 'acme' }]));
      const { values } = mockUpsert();
      await service.connect('u1', 'w1', 'sentry', 'sntryu_x', 'de.sentry.io');
      expect(fetchFn.mock.calls[0][0]).toBe('https://de.sentry.io/api/0/organizations/');
      expect(values.mock.calls[0][0]).toMatchObject({ host: 'https://de.sentry.io' });
    });

    it('refuses a host for other tools and self-hosted hosts on private addresses', async () => {
      await expect(service.connect('u1', 'w1', 'linear', 'lin_api_x', 'sentry.example.com')).rejects.toMatchObject({ response: { code: 'validation_error' } });
      await expect(service.connect('u1', 'w1', 'sentry', 'sntryu_x', 'https://10.0.0.7')).rejects.toMatchObject({ response: { code: 'connector_host_invalid' } });
      await expect(service.connect('u1', 'w1', 'sentry', 'sntryu_x', 'http://sentry.example.com')).rejects.toMatchObject({ response: { code: 'connector_host_invalid' } });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns the row host with the credential for the gateway and replies, and re-vets it', async () => {
      const { sealValue } = await import('../environments/secrets');
      const row = { id: 'c1', kind: 'sentry', status: 'connected', host: 'https://de.sentry.io', credentials: sealValue(KEY, JSON.stringify({ type: 'token', access: 't' })) };
      db.select.mockReturnValue(selectQ([row]));
      await expect(service.accessFor('w1', 'sentry')).resolves.toMatchObject({ access: 't', host: 'https://de.sentry.io' });
      db.select.mockReturnValue(selectQ([{ ...row, host: 'https://192.168.1.5' }]));
      await expect(service.accessFor('w1', 'sentry')).rejects.toMatchObject({ response: { code: 'connector_host_invalid' } });
    });

    it('maps a taken vendor account to connector_account_in_use', async () => {
      fetchFn.mockResolvedValue(json({ ok: true, team: 'Acme', team_id: 'T1', user_id: 'UBOT' }));
      const returning = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
      db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockReturnValue({ returning }) }) });
      await expect(service.connect('u1', 'w1', 'slack', 'xoxb-1')).rejects.toBeInstanceOf(ConnectorAccountInUseException);
    });

    it('resets the Figma allowlist to the new owner when a different Figma user reconnects', async () => {
      const { onConflictDoUpdate } = mockUpsert();
      db.select.mockReturnValue(selectQ([{ vendorUserId: 'fig-old' }]));
      fetchFn.mockResolvedValueOnce(json({ id: 'fig-new', handle: 'pat' }));
      await service.connect('u2', 'w1', 'figma', 'figd_new');
      expect(onConflictDoUpdate.mock.calls[0][0].set).toMatchObject({ allowedUsers: ['fig-new'], vendorUserId: 'fig-new', createdBy: 'u2' });
    });

    it('keeps admin-set Figma allowlist entries when the same Figma user reconnects', async () => {
      const { onConflictDoUpdate } = mockUpsert();
      db.select.mockReturnValue(selectQ([{ vendorUserId: 'fig-42' }]));
      fetchFn.mockResolvedValueOnce(json({ id: 'fig-42', handle: 'pat' }));
      await service.connect('u1', 'w1', 'figma', 'figd_x');
      expect(onConflictDoUpdate.mock.calls[0][0].set.allowedUsers).toBeUndefined();
    });

    const updateChain = () => {
      const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      db.update.mockReturnValue({ set });
      return set;
    };

    it('generates and returns a Figma passcode once, storing it sealed', async () => {
      db.select.mockReturnValue(rowQ([{ id: 'c1', kind: 'figma', externalId: null, webhookSecret: null }]));
      const set = updateChain();
      const out = await service.setWebhook('u1', 'w1', 'figma', { externalId: '77' });
      expect(out).toMatchObject({ kind: 'figma', externalId: '77', secret: expect.stringMatching(/^[0-9a-f]{48}$/) });
      expect(openValue(KEY, set.mock.calls[0][0].webhookSecret)).toBe(out.secret);
      expect(set.mock.calls[0][0].externalId).toBe('77');
    });

    it('stores a given secret without echoing it, and needs a secret where no app-level one exists', async () => {
      db.select.mockReturnValue(rowQ([{ id: 'c1', kind: 'linear', externalId: 'org-9', webhookSecret: null }]));
      await expect(service.setWebhook('u1', 'w1', 'linear', {})).rejects.toMatchObject({ response: { code: 'webhook_secret_required' } });
      const set = updateChain();
      const out = await service.setWebhook('u1', 'w1', 'linear', { secret: 'lin_wh_secret' });
      expect(out).toEqual({ kind: 'linear', externalId: 'org-9' });
      expect(openValue(KEY, set.mock.calls[0][0].webhookSecret)).toBe('lin_wh_secret');
      config.LINEAR_WEBHOOK_SECRET = 'app-level';
      await expect(service.setWebhook('u1', 'w1', 'linear', {})).resolves.toMatchObject({ kind: 'linear' });
    });

    it('refuses a typed Linear or Slack id that would route events signed with the shared app secret', async () => {
      config.LINEAR_WEBHOOK_SECRET = 'app-level';
      config.SLACK_SIGNING_SECRET = 'app-sign';
      const set = updateChain();
      db.select.mockReturnValue(rowQ([{ id: 'c1', kind: 'linear', externalId: 'org-mine', webhookSecret: null }]));
      await expect(service.setWebhook('u1', 'w1', 'linear', { externalId: 'org-victim' })).rejects.toMatchObject({ response: { code: 'webhook_secret_required' } });
      db.select.mockReturnValue(rowQ([{ id: 'c2', kind: 'slack', externalId: null, webhookSecret: null }]));
      await expect(service.setWebhook('u1', 'w1', 'slack', { externalId: 'T-victim' })).rejects.toMatchObject({ response: { code: 'webhook_secret_required' } });
      expect(set).not.toHaveBeenCalled();
      // The token-proven id, or a typed id with the admin's own secret, is fine.
      db.select.mockReturnValue(rowQ([{ id: 'c1', kind: 'linear', externalId: 'org-mine', webhookSecret: null }]));
      await expect(service.setWebhook('u1', 'w1', 'linear', { externalId: 'org-mine' })).resolves.toMatchObject({ externalId: 'org-mine' });
      await expect(service.setWebhook('u1', 'w1', 'linear', { externalId: 'org-other', secret: 'own-signing-secret' })).resolves.toMatchObject({ externalId: 'org-other' });
    });

    it('requires a per-connector secret and an id for Sentry, whose id an app secret cannot vouch for', async () => {
      db.select.mockReturnValue(rowQ([{ id: 'c1', kind: 'sentry', externalId: null, webhookSecret: null }]));
      updateChain();
      config.SENTRY_CLIENT_SECRET = 'oauth-secret';
      await expect(service.setWebhook('u1', 'w1', 'sentry', { externalId: 'inst-1' })).rejects.toMatchObject({ response: { code: 'webhook_secret_required' } });
      await expect(service.setWebhook('u1', 'w1', 'sentry', { secret: 'client-secret' })).rejects.toMatchObject({ response: { code: 'validation_error' } });
      await expect(service.setWebhook('u1', 'w1', 'sentry', { secret: 'client-secret', externalId: 'inst-1' })).resolves.toMatchObject({ externalId: 'inst-1' });
    });

    it('is admin only and needs a connected tool', async () => {
      orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException());
      await expect(service.setWebhook('u1', 'w1', 'figma', {})).rejects.toBeInstanceOf(ForbiddenException);
      db.select.mockReturnValue(rowQ([]));
      await expect(service.setWebhook('u1', 'w1', 'figma', {})).rejects.toBeInstanceOf(ConnectorNotFoundException);
    });

    it('picks the connector secret over the app-level one and never uses the app secret for Sentry or Figma', async () => {
      const { sealValue } = await import('../environments/secrets');
      config.SLACK_SIGNING_SECRET = 'app-sign';
      config.SENTRY_CLIENT_SECRET = 'oauth-secret';
      expect(service.webhookSecretsFor({ kind: 'slack', webhookSecret: null } as never)).toEqual(['app-sign']);
      expect(service.webhookSecretsFor({ kind: 'slack', webhookSecret: sealValue(KEY, 'own') } as never)).toEqual(['own']);
      expect(service.webhookSecretsFor({ kind: 'sentry', webhookSecret: null } as never)).toEqual([]);
      expect(service.webhookSecretsFor({ kind: 'figma', webhookSecret: null } as never)).toEqual([]);
    });
  });
  describe('who may start runs', () => {
    it('defaults the Figma allowlist to the connecting admin and records the Sentry organization', async () => {
      const { values } = mockUpsert();
      db.select.mockReturnValue(selectQ([]));
      fetchFn.mockResolvedValueOnce(json({ id: 'fig-42', handle: 'pat' }));
      await service.connect('u1', 'w1', 'figma', 'figd_x');
      expect(values.mock.calls[0][0]).toMatchObject({ allowedUsers: ['fig-42'], vendorUserId: 'fig-42' });
      fetchFn.mockResolvedValueOnce(json([{ slug: 'acme' }]));
      await service.connect('u1', 'w1', 'sentry', 'sntryu_x');
      expect(values.mock.calls[1][0]).toMatchObject({ vendorOrg: 'acme' });
      expect(values.mock.calls[1][0].allowedUsers).toBeUndefined();
    });

    const updateChain = () => {
      const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      db.update.mockReturnValue({ set });
      return set;
    };
    const rows = (over: Row = {}) => selectQ([{ id: 'c1', kind: 'sentry', externalId: 'inst-1', webhookSecret: { sealed: true }, allowedUsers: [], triggersEnabled: false, ...over }]);

    it('lets an admin opt Sentry triggers in and set the allowlist, deduplicated', async () => {
      db.select.mockReturnValue(rows());
      const set = updateChain();
      const out = await service.setWebhook('u1', 'w1', 'sentry', { triggersEnabled: true, allowedUsers: [' 7 ', '7', '9'] });
      expect(set.mock.calls[0][0]).toMatchObject({ triggersEnabled: true, allowedUsers: ['7', '9'] });
      expect(out).toMatchObject({ triggersEnabled: true, allowedUsers: ['7', '9'], externalId: 'inst-1' });
    });

    it('leaves the opt-in and allowlist alone when they are not sent, and reports them', async () => {
      db.select.mockReturnValue(rows({ allowedUsers: ['5'], triggersEnabled: true }));
      const set = updateChain();
      const out = await service.setWebhook('u1', 'w1', 'sentry', { externalId: 'inst-1' });
      expect(set.mock.calls[0][0]).not.toHaveProperty('triggersEnabled');
      expect(set.mock.calls[0][0]).not.toHaveProperty('allowedUsers');
      expect(out).toMatchObject({ triggersEnabled: true, allowedUsers: ['5'] });
    });

    it('does not rotate a Figma passcode when only the allowlist changes', async () => {
      db.select.mockReturnValue(rows({ kind: 'figma', externalId: '77' }));
      const set = updateChain();
      const out = await service.setWebhook('u1', 'w1', 'figma', { allowedUsers: ['99'] });
      expect(set.mock.calls[0][0]).not.toHaveProperty('webhookSecret');
      expect(out.secret).toBeUndefined();
    });
  });
});

describe('deriveCredentialType', () => {
  const token = (access: string) => ({ type: 'token' as const, access });
  it('calls any OAuth credential oauth, even one that looks like a bot token', () => {
    expect(deriveCredentialType('slack', { type: 'oauth', access: 'xoxb-1' })).toBe('oauth');
  });
  it('tells token kinds apart by vendor prefix', () => {
    expect(deriveCredentialType('figma', token('figd_a'))).toBe('personal_token');
    expect(deriveCredentialType('linear', token('lin_api_a'))).toBe('personal_token');
    expect(deriveCredentialType('slack', token('xoxb-a'))).toBe('bot_token');
    expect(deriveCredentialType('slack', token('xoxp-a'))).toBe('user_token');
    expect(deriveCredentialType('sentry', token('sntrys_a'))).toBe('org_token');
    expect(deriveCredentialType('sentry', token('sntryu_a'))).toBe('user_token');
  });
  it('falls back to a plain token for unrecognised shapes', () => {
    expect(deriveCredentialType('sentry', token('abcdef'))).toBe('token');
    expect(deriveCredentialType('slack', token('xapp-1'))).toBe('token');
  });
});
