import { vi } from 'vitest';
import { linearSetState, postReply } from './connector-replies';

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
const bearer = { type: 'oauth' as const, access: 'tok' };

describe('postReply', () => {
  it('comments on a Linear issue through GraphQL with the raw personal key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: { commentCreate: { success: true } } }));
    await postReply(fetchFn, 'linear', { type: 'token', access: 'lin_api_x' }, { issueId: 'i1' }, 'done');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.headers.authorization).toBe('lin_api_x');
    expect(JSON.parse(init.body).variables).toEqual({ issueId: 'i1', body: 'done' });
  });

  it('posts into the Slack thread and fails when Slack answers ok:false', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(ok({ ok: true })).mockResolvedValueOnce(ok({ ok: false, error: 'channel_not_found' }));
    await postReply(fetchFn, 'slack', bearer, { channel: 'C1', threadTs: '1.2' }, 'hi');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ channel: 'C1', thread_ts: '1.2', text: 'hi' });
    await expect(postReply(fetchFn, 'slack', bearer, { channel: 'C1', threadTs: '1.2' }, 'hi')).rejects.toThrow();
  });

  it('adds a note to a Sentry issue on the connector host', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok());
    await postReply(fetchFn, 'sentry', { ...bearer, host: 'https://de.sentry.io' }, { issueId: '42', org: 'acme' }, 'fixed');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://de.sentry.io/api/0/organizations/acme/issues/42/comments/');
    expect(JSON.parse(init.body)).toEqual({ text: 'fixed' });
  });

  it('refuses a Sentry note when the organization is unknown', async () => {
    await expect(postReply(vi.fn(), 'sentry', bearer, { issueId: '42' }, 'x')).rejects.toThrow('organization');
  });

  it('replies to a Figma comment with the Figma token header for personal tokens', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok());
    await postReply(fetchFn, 'figma', { type: 'token', access: 'figd_x' }, { fileKey: 'FK', commentId: '5' }, 'on it');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.figma.com/v1/files/FK/comments');
    expect(init.headers['x-figma-token']).toBe('figd_x');
    expect(JSON.parse(init.body)).toEqual({ message: 'on it', comment_id: '5' });
  });

  it('clips long summaries and surfaces vendor errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ ok: true }));
    await postReply(fetchFn, 'slack', bearer, { channel: 'C', threadTs: '1' }, 'x'.repeat(5000));
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).text.length).toBe(2003);
    await expect(postReply(vi.fn().mockResolvedValue(new Response('{}', { status: 500 })), 'sentry', bearer, { issueId: '1' }, 'x')).rejects.toThrow();
  });
});

describe('postReply scrubbing', () => {
  it('removes credentials from every reply and cannot re-trigger itself with @dock', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ ok: true }));
    await postReply(fetchFn, 'slack', bearer, { channel: 'C', threadTs: '1' }, `env dump: ${'ab'.repeat(32)} xoxb-1234567890-abcdefABC sk-ant-api03-abcdefghij @dock again`);
    const text = JSON.parse(fetchFn.mock.calls[0][1].body).text as string;
    expect(text).not.toMatch(/abab|xoxb|sk-ant/);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('@dock');
  });
});

describe('linearSetState', () => {
  it('moves the issue to the first state of the requested type', async () => {
    const nodes = [
      { id: 's2', type: 'started', position: 2 },
      { id: 's1', type: 'started', position: 1 },
      { id: 'd', type: 'completed', position: 3 },
    ];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok({ data: { issue: { team: { states: { nodes } } } } }))
      .mockResolvedValueOnce(ok({ data: { issueUpdate: { success: true } } }));
    await linearSetState(fetchFn, bearer, 'i1', 'started');
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).variables).toEqual({ id: 'i1', stateId: 's1' });
  });

  it('does nothing when the team has no such state', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ data: { issue: { team: { states: { nodes: [] } } } } }));
    await linearSetState(fetchFn, bearer, 'i1', 'completed');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
