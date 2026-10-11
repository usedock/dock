import { vi } from 'vitest';
import { authorizeUrl, exchangeCode, needsRefresh, newPkce, oauthClient, refreshCredential, signState, verifyState } from './connector-oauth';

const secret = Buffer.alloc(32, 7);
const base = { u: 'user-1', w: 'ws-1', k: 'linear' as const, n: 'nonce', e: Math.floor(Date.now() / 1000) + 600 };
const client = { id: 'cid', secret: 'csecret' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const args = { code: 'c', redirectUri: 'r', verifier: null };

describe('oauth state', () => {
  it('round-trips the user, workspace and kind it was signed for', () => {
    expect(verifyState(secret, signState(secret, base), 'linear')).toEqual(base);
  });

  it('rejects a tampered payload or signature', () => {
    const [body, sig] = signState(secret, base).split('.');
    const forged = Buffer.from(JSON.stringify({ ...base, u: 'attacker' })).toString('base64url');
    expect(() => verifyState(secret, `${forged}.${sig}`, 'linear')).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'invalid_state' }) }));
    expect(() => verifyState(secret, `${body}.x${sig}`, 'linear')).toThrow();
  });

  it('rejects a state signed with another key, for another kind, malformed or expired', () => {
    expect(() => verifyState(Buffer.alloc(32, 8), signState(secret, base), 'linear')).toThrow();
    expect(() => verifyState(secret, signState(secret, base), 'figma')).toThrow();
    expect(() => verifyState(secret, 'garbage', 'linear')).toThrow();
    expect(() => verifyState(secret, '', 'linear')).toThrow();
    expect(() => verifyState(secret, signState(secret, { ...base, e: 1000 }), 'linear')).toThrow();
    expect(() => verifyState(secret, signState(secret, base), 'linear', Date.now() + 601_000)).toThrow();
  });
});

describe('authorizeUrl', () => {
  it('builds the vendor authorize URL with PKCE only when asked', () => {
    const { challenge } = newPkce();
    const url = new URL(authorizeUrl('linear', 'cid', 'https://api.example/cb', 'st', challenge));
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'cid', response_type: 'code', state: 'st', scope: 'read,write', code_challenge: challenge, code_challenge_method: 'S256' });
    const slack = new URL(authorizeUrl('slack', 'cid', 'https://api.example/cb', 'st', null));
    expect(slack.origin + slack.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(slack.searchParams.has('code_challenge')).toBe(false);
    expect(new URL(authorizeUrl('sentry', 'c', 'r', 's', null)).searchParams.get('scope')).toBe('org:read project:read event:read');
    expect(new URL(authorizeUrl('figma', 'c', 'r', 's', null)).origin).toBe('https://www.figma.com');
  });
});

describe('oauthClient', () => {
  it('is null unless both id and secret are set', () => {
    expect(oauthClient({ get: (k) => (k === 'LINEAR_CLIENT_ID' ? 'a' : undefined) as never }, 'linear')).toBeNull();
    expect(oauthClient({ get: (k) => ({ LINEAR_CLIENT_ID: 'a', LINEAR_CLIENT_SECRET: 'b' })[k as string] as never }, 'linear')).toEqual({ id: 'a', secret: 'b' });
  });
});

describe('token exchange', () => {
  it('posts the code with body credentials to Linear and records expiry and refresh token', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ access_token: 'at', refresh_token: 'rt', expires_in: 86400, scope: 'read write' }));
    const out = await exchangeCode(fetchFn, 'linear', client, { code: 'c1', redirectUri: 'https://api/cb', verifier: 'v' }, 1000);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.linear.app/oauth/token');
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({ grant_type: 'authorization_code', code: 'c1', client_id: 'cid', client_secret: 'csecret', code_verifier: 'v' });
    expect(out).toEqual({ credential: { type: 'oauth', access: 'at', refresh: 'rt', expiresAt: 1000 + 86_400_000 }, scopes: ['read', 'write'], label: null });
  });

  it('sends Figma client credentials as Basic auth', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ access_token: 'at', refresh_token: 'rt', expires_in: 10 }));
    await exchangeCode(fetchFn, 'figma', client, args);
    const init = fetchFn.mock.calls[0][1];
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect((init.body as URLSearchParams).has('client_secret')).toBe(false);
  });

  it('reads the Slack team as the account label and treats ok:false as a failure', async () => {
    const ok = await exchangeCode(vi.fn().mockResolvedValue(json({ ok: true, access_token: 'xoxb', scope: 'chat:write,users:read', team: { name: 'Acme' } })), 'slack', client, args);
    expect(ok).toMatchObject({ label: 'Acme', scopes: ['chat:write', 'users:read'], credential: { access: 'xoxb' } });
    await expect(exchangeCode(vi.fn().mockResolvedValue(json({ ok: false, error: 'invalid_code' })), 'slack', client, args)).rejects.toMatchObject({ response: { code: 'connector_unreachable' } });
  });

  it('reads Sentry token, refreshToken and expiresAt', async () => {
    const out = await exchangeCode(vi.fn().mockResolvedValue(json({ token: 't', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z', scopes: ['org:read'] })), 'sentry', client, args);
    expect(out.credential).toEqual({ type: 'oauth', access: 't', refresh: 'r', expiresAt: Date.parse('2030-01-01T00:00:00.000Z') });
    expect(out.scopes).toEqual(['org:read']);
  });

  it('fails closed on HTTP errors, missing tokens and network errors', async () => {
    for (const fetchFn of [vi.fn().mockResolvedValue(json({ error: 'bad' }, 400)), vi.fn().mockResolvedValue(json({})), vi.fn().mockRejectedValue(new Error('down'))]) {
      await expect(exchangeCode(fetchFn, 'linear', client, args)).rejects.toMatchObject({ response: { code: 'connector_unreachable' } });
    }
  });
});

describe('refresh', () => {
  it('uses the Figma refresh endpoint and keeps the refresh token it was not given again', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ access_token: 'new', expires_in: 60 }));
    const out = await refreshCredential(fetchFn, 'figma', client, { type: 'oauth', access: 'old', refresh: 'rt' }, 0);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.figma.com/v1/oauth/refresh');
    expect(out).toEqual({ type: 'oauth', access: 'new', refresh: 'rt', expiresAt: 60_000 });
  });

  it('has nothing to refresh without a refresh token, and flags near-expiry only for OAuth', async () => {
    await expect(refreshCredential(vi.fn(), 'linear', client, { type: 'oauth', access: 'a' })).resolves.toBeNull();
    expect(needsRefresh({ type: 'oauth', access: 'a', expiresAt: Date.now() + 10_000 })).toBe(true);
    expect(needsRefresh({ type: 'oauth', access: 'a', expiresAt: Date.now() + 3_600_000 })).toBe(false);
    expect(needsRefresh({ type: 'token', access: 'a' })).toBe(false);
  });
});
