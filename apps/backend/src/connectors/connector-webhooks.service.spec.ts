import { createHmac } from 'crypto';
import { vi, type Mock } from 'vitest';
import { ConnectorWebhooksService } from './connector-webhooks.service';

const NOW = 1_800_000_000_000;
const hex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const unique = Object.assign(new Error('duplicate'), { code: '23505' });

function connector(kind: string, over: Record<string, unknown> = {}) {
  return { id: `c-${kind}`, workspaceId: 'w1', kind, createdBy: 'admin-1', vendorUserId: 'me', externalId: kind === 'linear' ? 'org-1' : 'ext', triggersEnabled: true, allowedUsers: ['7'], vendorOrg: null, ...over };
}

describe('ConnectorWebhooksService', () => {
  let db: { insert: Mock };
  let insertValues: Mock;
  let connectors: { findByExternalId: Mock; listByKind: Mock; webhookSecretsFor: Mock; envWebhookSecret: Mock; accessFor: Mock };
  let runs: { start: Mock; notify: Mock };
  let fetchFn: Mock;
  let service: ConnectorWebhooksService;

  beforeEach(() => {
    insertValues = vi.fn().mockResolvedValue(undefined);
    db = { insert: vi.fn().mockReturnValue({ values: insertValues }) };
    connectors = { findByExternalId: vi.fn(), listByKind: vi.fn().mockResolvedValue([]), webhookSecretsFor: vi.fn().mockReturnValue(['secret']), envWebhookSecret: vi.fn().mockReturnValue(null), accessFor: vi.fn().mockResolvedValue({ type: 'oauth', access: 'tok' }) };
    runs = { start: vi.fn().mockResolvedValue({ status: 'started', id: 'run-1' }), notify: vi.fn() };
    // Vendor identity calls the requester gate makes: a full Slack member and an active Linear member.
    fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('users.info')) return new Response(JSON.stringify({ ok: true, user: { id: 'U1', team_id: 'ext' } }), { status: 200 });
      return new Response(JSON.stringify({ data: { user: { id: 'u1', active: true, guest: false, organization: { id: 'org-1' } } } }), { status: 200 });
    });
    service = new ConnectorWebhooksService(db as never, connectors as never, runs as never, { fetchFn: fetchFn as never });
  });

  const raw = (body: unknown) => Buffer.from(JSON.stringify(body));

  describe('linear', () => {
    const assigned = { action: 'update', type: 'Issue', organizationId: 'org-1', actor: { type: 'user', id: 'u1' }, webhookTimestamp: NOW, data: { id: 'i1', identifier: 'ENG-1', title: 'T', assigneeId: 'me' }, updatedFrom: { assigneeId: null } };
    const req = (body: unknown, secret = 'secret', delivery = 'd1') => {
      const rawBody = raw(body);
      return { rawBody, headers: { 'linear-signature': hex(secret, rawBody), 'linear-delivery': delivery } };
    };

    it('routes by organization, verifies and starts a run with the connector attached', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear', { externalId: 'org-1' }));
      const out = await service.handle('linear', req(assigned), NOW);
      expect(connectors.findByExternalId).toHaveBeenCalledWith('linear', 'org-1');
      expect(out).toEqual({ status: 200, body: { received: true, runId: 'run-1' } });
      expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', createdBy: 'admin-1' }), expect.objectContaining({ kind: 'linear', key: 'issue:i1' }));
      expect(insertValues).toHaveBeenCalledWith({ kind: 'linear', deliveryId: 'd1' });
    });

    it('refuses a bad signature before dedupe or any run', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      await expect(service.handle('linear', req(assigned, 'wrong'), NOW)).rejects.toMatchObject({ response: { code: 'invalid_signature' } });
      expect(insertValues).not.toHaveBeenCalled();
      expect(runs.start).not.toHaveBeenCalled();
    });

    it('refuses a stale timestamp', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      await expect(service.handle('linear', req({ ...assigned, webhookTimestamp: NOW - 120_000 }), NOW)).rejects.toMatchObject({ response: { code: 'stale_webhook' } });
    });

    it('refuses when no secret is configured for the connector', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      connectors.webhookSecretsFor.mockReturnValue([]);
      await expect(service.handle('linear', req(assigned), NOW)).rejects.toMatchObject({ response: { code: 'invalid_signature' } });
    });

    it('404s an account no workspace has connected', async () => {
      connectors.findByExternalId.mockResolvedValue(null);
      await expect(service.handle('linear', req(assigned), NOW)).rejects.toMatchObject({ response: { code: 'connector_not_found' } });
    });

    it('treats a replayed delivery as a duplicate and starts nothing', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      insertValues.mockRejectedValueOnce(unique);
      const out = await service.handle('linear', req(assigned), NOW);
      expect(out.body).toEqual({ received: true, duplicate: true });
      expect(runs.start).not.toHaveBeenCalled();
    });

    it('treats a replayed body with a fresh Linear-Delivery as a duplicate', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      const seen = new Set<string>();
      insertValues.mockImplementation(async (row: { deliveryId: string }) => {
        if (seen.has(row.deliveryId)) throw unique;
        seen.add(row.deliveryId);
      });
      expect((await service.handle('linear', req(assigned, 'secret', 'd1'), NOW)).body).toEqual({ received: true, runId: 'run-1' });
      expect((await service.handle('linear', req(assigned, 'secret', 'd2'), NOW)).body).toEqual({ received: true, duplicate: true });
      expect((await service.handle('linear', req({ ...assigned, webhookTimestamp: NOW + 1 }, 'secret', 'd1'), NOW)).body).toEqual({ received: true, duplicate: true });
      expect(runs.start).toHaveBeenCalledTimes(1);
    });

    it('acknowledges events that are not triggers without a run', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      const out = await service.handle('linear', req({ ...assigned, type: 'Comment' }), NOW);
      expect(out.body).toEqual({ received: true, ignored: true });
      expect(runs.start).not.toHaveBeenCalled();
    });

    it('still answers 200 when starting the run fails', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear'));
      runs.start.mockRejectedValue(new Error('db down'));
      const out = await service.handle('linear', req(assigned), NOW);
      expect(out).toEqual({ status: 200, body: { received: true, runId: null } });
    });

    it('rejects a body that is not JSON', async () => {
      await expect(service.handle('linear', { rawBody: Buffer.from('nope'), headers: {} }, NOW)).rejects.toMatchObject({ response: { code: 'validation_error' } });
    });
  });

  describe('slack', () => {
    const ts = String(NOW / 1000);
    const mention = { type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', channel: 'C1', ts: '1.1', text: '<@B> hi', user: 'U1' } };
    const req = (body: unknown, secret = 'secret', stamp = ts) => {
      const rawBody = raw(body);
      return { rawBody, headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${hex(secret, `v0:${stamp}:${rawBody.toString()}`)}` } };
    };

    it('routes by team id and starts a run on app_mention', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      const out = await service.handle('slack', req(mention), NOW);
      expect(connectors.findByExternalId).toHaveBeenCalledWith('slack', 'T1');
      expect(out.body).toEqual({ received: true, runId: 'run-1' });
      expect(insertValues).toHaveBeenCalledWith({ kind: 'slack', deliveryId: 'Ev1' });
      expect(runs.start.mock.calls[0][1]).toMatchObject({ reply: { channel: 'C1', threadTs: '1.1' } });
    });

    it('answers url_verification with the bare challenge when any connected secret signs it', async () => {
      connectors.listByKind.mockResolvedValue([connector('slack')]);
      const out = await service.handle('slack', req({ type: 'url_verification', challenge: 'abc123' }), NOW);
      expect(out).toEqual({ status: 200, body: 'abc123' });
      expect(connectors.findByExternalId).not.toHaveBeenCalled();
    });

    it('answers url_verification signed with the app-level secret before any workspace connects', async () => {
      connectors.envWebhookSecret.mockReturnValue('app-secret');
      const out = await service.handle('slack', req({ type: 'url_verification', challenge: 'c1' }, 'app-secret'), NOW);
      expect(out).toEqual({ status: 200, body: 'c1' });
    });

    it('refuses an unsigned url_verification', async () => {
      connectors.listByKind.mockResolvedValue([connector('slack')]);
      await expect(service.handle('slack', req({ type: 'url_verification', challenge: 'x' }, 'wrong'), NOW)).rejects.toMatchObject({ response: { code: 'invalid_signature' } });
    });

    it('refuses a stale timestamp even with a valid signature', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      await expect(service.handle('slack', req(mention, 'secret', String(NOW / 1000 - 400)), NOW)).rejects.toMatchObject({ response: { code: 'stale_webhook' } });
    });

    it('ignores a Slack retry of an event it already took', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      insertValues.mockRejectedValueOnce(unique);
      expect((await service.handle('slack', req(mention), NOW)).body).toEqual({ received: true, duplicate: true });
    });
  });

  describe('sentry', () => {
    const issue = { action: 'created', installation: { uuid: 'inst-1' }, data: { issue: { id: '9', title: 'Boom' } } };
    const req = (body: unknown, secret = 'secret') => {
      const rawBody = raw(body);
      return { rawBody, headers: { 'sentry-hook-signature': hex(secret, rawBody), 'sentry-hook-resource': 'issue', 'request-id': 'r1' } };
    };

    it('routes by installation uuid and starts a run on issue.created', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('sentry'));
      const out = await service.handle('sentry', req(issue), NOW);
      expect(connectors.findByExternalId).toHaveBeenCalledWith('sentry', 'inst-1');
      expect(out.body).toEqual({ received: true, runId: 'run-1' });
      expect(insertValues).toHaveBeenCalledWith({ kind: 'sentry', deliveryId: 'r1' });
    });

    it('refuses a bad signature and dedupes a replayed Request-ID', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('sentry'));
      await expect(service.handle('sentry', req(issue, 'wrong'), NOW)).rejects.toMatchObject({ response: { code: 'invalid_signature' } });
      insertValues.mockRejectedValueOnce(unique);
      expect((await service.handle('sentry', req(issue), NOW)).body).toMatchObject({ duplicate: true });
    });
    it('treats a captured body replayed with a new Request-ID as a duplicate', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('sentry'));
      const seen = new Set<string>();
      insertValues.mockImplementation(async (row: { deliveryId: string }) => {
        if (seen.has(row.deliveryId)) throw unique;
        seen.add(row.deliveryId);
      });
      const first = req(issue);
      expect((await service.handle('sentry', first, NOW)).body).toEqual({ received: true, runId: 'run-1' });
      const replay = { ...first, headers: { ...first.headers, 'request-id': 'r2' } };
      expect((await service.handle('sentry', replay, NOW)).body).toEqual({ received: true, duplicate: true });
      expect(runs.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('figma', () => {
    const comment = { event_type: 'FILE_COMMENT', passcode: 'secret', webhook_id: 77, timestamp: '2026-01-01T00:00:00Z', file_key: 'FK', comment_id: 5, comment: [{ text: '@dock tidy this' }], mentions: [], triggered_by: { id: '7' } };
    const req = (body: unknown) => ({ rawBody: raw(body), headers: {} });

    it('routes by webhook id, compares the passcode and starts a run on an @dock comment', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('figma'));
      const out = await service.handle('figma', req(comment), NOW);
      expect(connectors.findByExternalId).toHaveBeenCalledWith('figma', '77');
      expect(out.body).toEqual({ received: true, runId: 'run-1' });
      expect(runs.start.mock.calls[0][1]).toMatchObject({ reply: { fileKey: 'FK', commentId: '5' } });
    });

    it('refuses a wrong passcode and acknowledges the ping without a run', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('figma'));
      await expect(service.handle('figma', req({ ...comment, passcode: 'nope' }), NOW)).rejects.toMatchObject({ response: { code: 'invalid_signature' } });
      const out = await service.handle('figma', req({ event_type: 'PING', passcode: 'secret', webhook_id: 77 }), NOW);
      expect(out.body).toEqual({ received: true, ignored: true });
      expect(runs.start).not.toHaveBeenCalled();
    });

    it('dedupes a redelivered comment', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('figma'));
      insertValues.mockRejectedValueOnce(unique);
      expect((await service.handle('figma', req(comment), NOW)).body).toMatchObject({ duplicate: true });
    });
  });

  describe('requester gating', () => {
    const slackMention = { type: 'event_callback', team_id: 'ext', event_id: 'EvG', event: { type: 'app_mention', channel: 'C1', ts: '1.1', text: '<@B> run env', user: 'U9' } };
    const ts = String(NOW / 1000);
    const slackReq = (body: unknown) => {
      const rawBody = raw(body);
      return { rawBody, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hex('secret', `v0:${ts}:${rawBody.toString()}`)}` } };
    };

    it('starts nothing for a Slack guest and explains why in the thread', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      fetchFn.mockResolvedValue(new Response(JSON.stringify({ ok: true, user: { id: 'U9', team_id: 'ext', is_restricted: true } }), { status: 200 }));
      const out = await service.handle('slack', slackReq(slackMention), NOW);
      expect(out.body).toMatchObject({ ignored: true, reason: 'requester_not_allowed' });
      expect(runs.start).not.toHaveBeenCalled();
      expect(runs.notify).toHaveBeenCalledWith('w1', 'slack', { channel: 'C1', threadTs: '1.1' }, expect.stringContaining('full members'));
    });

    it('starts nothing for a Slack Connect user from another team', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      fetchFn.mockResolvedValue(new Response(JSON.stringify({ ok: true, user: { id: 'U9', team_id: 'T-other' } }), { status: 200 }));
      await service.handle('slack', slackReq(slackMention), NOW);
      expect(runs.start).not.toHaveBeenCalled();
    });

    it('starts nothing, silently, when the connector credential cannot be used to check the sender', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      connectors.accessFor.mockRejectedValue(new Error('reauth'));
      await service.handle('slack', slackReq(slackMention), NOW);
      expect(runs.start).not.toHaveBeenCalled();
      expect(runs.notify).not.toHaveBeenCalled();
    });

    it('refuses a Linear guest', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('linear', { externalId: 'org-1' }));
      fetchFn.mockResolvedValue(new Response(JSON.stringify({ data: { user: { id: 'u1', active: true, guest: true, organization: { id: 'org-1' } } } }), { status: 200 }));
      const body = { action: 'update', type: 'Issue', organizationId: 'org-1', actor: { type: 'user', id: 'u1' }, webhookTimestamp: NOW, data: { id: 'i1', assigneeId: 'me' }, updatedFrom: { assigneeId: null } };
      const rawBody = raw(body);
      const out = await service.handle('linear', { rawBody, headers: { 'linear-signature': hex('secret', rawBody), 'linear-delivery': 'dG' } }, NOW);
      expect(out.body).toMatchObject({ ignored: true });
      expect(runs.start).not.toHaveBeenCalled();
      expect(runs.notify).toHaveBeenCalledWith('w1', 'linear', { issueId: 'i1' }, expect.stringContaining('not guests'));
    });

    it('refuses a Figma commenter who is not allowlisted and admits the allowlisted one', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('figma', { allowedUsers: ['99'] }));
      const comment = { event_type: 'FILE_COMMENT', passcode: 'secret', webhook_id: 77, timestamp: 't1', file_key: 'FK', comment_id: 5, comment: [{ text: '@dock hi' }], mentions: [], triggered_by: { id: '7' } };
      const out = await service.handle('figma', { rawBody: raw(comment), headers: {} }, NOW);
      expect(out.body).toMatchObject({ reason: 'requester_not_allowed' });
      expect(runs.notify).toHaveBeenCalledWith('w1', 'figma', { fileKey: 'FK', commentId: '5' }, expect.stringContaining('allowlist'));
      const ok = await service.handle('figma', { rawBody: raw({ ...comment, timestamp: 't2', triggered_by: { id: '99' } }), headers: {} }, NOW);
      expect(ok.body).toEqual({ received: true, runId: 'run-1' });
    });

    it('ignores Sentry events until an admin opts in', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('sentry', { triggersEnabled: false }));
      const body = { action: 'created', installation: { uuid: 'inst-1' }, data: { issue: { id: '9', title: 'Boom' } } };
      const rawBody = raw(body);
      const out = await service.handle('sentry', { rawBody, headers: { 'sentry-hook-signature': hex('secret', rawBody), 'sentry-hook-resource': 'issue', 'request-id': 'rg' } }, NOW);
      expect(out.body).toMatchObject({ ignored: true });
      expect(runs.start).not.toHaveBeenCalled();
      expect(runs.notify).not.toHaveBeenCalled();
    });

    it('fills the Sentry organization from the connector when the event URL has none', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('sentry', { vendorOrg: 'acme' }));
      const body = { action: 'created', installation: { uuid: 'inst-1' }, data: { issue: { id: '9', title: 'Boom', web_url: 'https://sentry.io/issues/9/' } } };
      const rawBody = raw(body);
      await service.handle('sentry', { rawBody, headers: { 'sentry-hook-signature': hex('secret', rawBody), 'sentry-hook-resource': 'issue', 'request-id': 'ro' } }, NOW);
      expect(runs.start.mock.calls[0][1].reply).toEqual({ issueId: '9', org: 'acme' });
    });

    it('tells Slack and Linear users when the workspace is busy, and keeps Sentry quiet', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      runs.start.mockResolvedValue({ status: 'busy' });
      const slack = await service.handle('slack', slackReq({ ...slackMention, event_id: 'EvB' }), NOW);
      expect(slack.body).toMatchObject({ busy: true });
      expect(runs.notify).toHaveBeenCalledWith('w1', 'slack', { channel: 'C1', threadTs: '1.1' }, expect.stringContaining('busy'));
      runs.notify.mockClear();
      connectors.findByExternalId.mockResolvedValue(connector('sentry'));
      const body = { action: 'created', installation: { uuid: 'inst-1' }, data: { issue: { id: '9', title: 'Boom' } } };
      const rawBody = raw(body);
      await service.handle('sentry', { rawBody, headers: { 'sentry-hook-signature': hex('secret', rawBody), 'sentry-hook-resource': 'issue', 'request-id': 'rb' } }, NOW);
      expect(runs.notify).not.toHaveBeenCalled();
    });

    it('does not claim a run for a duplicate subject', async () => {
      connectors.findByExternalId.mockResolvedValue(connector('slack'));
      runs.start.mockResolvedValue({ status: 'duplicate' });
      expect((await service.handle('slack', slackReq({ ...slackMention, event_id: 'EvD' }), NOW)).body).toEqual({ received: true, runId: null });
    });
  });
});
