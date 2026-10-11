import { vi } from 'vitest';
import { admitFigma, admitLinear, admitSentry, admitSlack } from './connector-gate';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const access = { type: 'oauth' as const, access: 'tok' };
const slackConnector = { kind: 'slack', externalId: 'T1', workspaceId: 'w1' } as never;
const mention = (event: Record<string, unknown> = {}) => ({ event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1.1', ...event } });
const member = { id: 'U1', team_id: 'T1', is_restricted: false, is_ultra_restricted: false, is_bot: false, deleted: false };

describe('admitSlack', () => {
  it('admits a full member of the connected team', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ ok: true, user: member }));
    expect(await admitSlack(fetchFn, access, slackConnector, mention())).toEqual({ ok: true });
    expect(fetchFn.mock.calls[0][0]).toBe('https://slack.com/api/users.info?user=U1');
  });

  it.each([
    ['a guest', { ...member, is_restricted: true }],
    ['a single-channel guest', { ...member, is_ultra_restricted: true }],
    ['a Slack Connect stranger', { ...member, is_stranger: true }],
    ['a user of another team', { ...member, team_id: 'T2' }],
    ['a bot', { ...member, is_bot: true }],
    ['a deactivated user', { ...member, deleted: true }],
  ])('refuses %s with an explanation', async (_name, user) => {
    const out = await admitSlack(vi.fn().mockResolvedValue(ok({ ok: true, user })), access, slackConnector, mention());
    expect(out).toMatchObject({ ok: false, say: expect.stringContaining('full members') });
  });

  it('refuses an external user the event itself names, without calling Slack', async () => {
    const fetchFn = vi.fn();
    expect(await admitSlack(fetchFn, access, slackConnector, mention({ user_team: 'T2' }))).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails closed and silently when Slack cannot answer', async () => {
    expect(await admitSlack(vi.fn().mockRejectedValue(new Error('timeout')), access, slackConnector, mention())).toEqual({ ok: false });
    expect(await admitSlack(vi.fn().mockResolvedValue(ok({ ok: false, error: 'user_not_found' })), access, slackConnector, mention())).toEqual({ ok: false });
    expect(await admitSlack(vi.fn().mockResolvedValue(new Response('{}', { status: 500 })), access, slackConnector, mention())).toEqual({ ok: false });
    expect(await admitSlack(vi.fn(), access, slackConnector, { event: {} })).toEqual({ ok: false });
  });
});

describe('admitLinear', () => {
  const connector = { kind: 'linear', externalId: 'org-1' } as never;
  const issue = (actor: Record<string, unknown> | undefined) => ({ actor });
  const user = (over: Record<string, unknown> = {}) => ok({ data: { user: { id: 'u1', active: true, guest: false, organization: { id: 'org-1' }, ...over } } });

  it('admits an active non-guest member of the connected organization', async () => {
    const fetchFn = vi.fn().mockResolvedValue(user());
    expect(await admitLinear(fetchFn, access, connector, issue({ type: 'user', id: 'u1' }))).toEqual({ ok: true });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).variables).toEqual({ id: 'u1' });
  });

  it.each([
    ['a guest', { guest: true }],
    ['a suspended user', { active: false }],
    ['a user of another organization', { organization: { id: 'org-2' } }],
  ])('refuses %s with a comment', async (_name, over) => {
    expect(await admitLinear(vi.fn().mockResolvedValue(user(over)), access, connector, issue({ type: 'user', id: 'u1' }))).toMatchObject({ ok: false, say: expect.stringContaining('not guests') });
  });

  it('refuses integration actors and missing actors, and fails closed on API errors', async () => {
    const fetchFn = vi.fn();
    expect(await admitLinear(fetchFn, access, connector, issue({ type: 'OauthClient', id: 'a1' }))).toEqual({ ok: false });
    expect(await admitLinear(fetchFn, access, connector, issue(undefined))).toEqual({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await admitLinear(vi.fn().mockResolvedValue(ok({ errors: [{ message: 'no' }] })), access, connector, issue({ type: 'user', id: 'u1' }))).toEqual({ ok: false });
    expect(await admitLinear(vi.fn().mockRejectedValue(new Error('x')), access, connector, issue({ type: 'user', id: 'u1' }))).toEqual({ ok: false });
  });
});

describe('admitFigma', () => {
  const connector = { allowedUsers: ['99'] } as never;

  it('admits only allowlisted Figma users', () => {
    expect(admitFigma(connector, { triggered_by: { id: '99' } })).toEqual({ ok: true });
    expect(admitFigma(connector, { triggered_by: { id: 99 } })).toEqual({ ok: true });
    expect(admitFigma(connector, { triggered_by: { id: '7' } })).toMatchObject({ ok: false, say: expect.stringContaining('allowlist') });
    expect(admitFigma(connector, {})).toMatchObject({ ok: false });
    expect(admitFigma({ allowedUsers: [] } as never, { triggered_by: { id: '99' } })).toMatchObject({ ok: false });
  });
});

describe('admitSentry', () => {
  it('is opt-in', () => {
    expect(admitSentry({ triggersEnabled: false } as never)).toEqual({ ok: false });
    expect(admitSentry({ triggersEnabled: true } as never)).toEqual({ ok: true });
  });
});
