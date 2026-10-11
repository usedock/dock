import { vi, type Mock } from 'vitest';
import { ConnectorOauthService } from './connector-oauth.service';
import { signState } from './connector-oauth';

const KEY_HEX = 'cd'.repeat(32);
const secret = Buffer.from(KEY_HEX, 'hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('ConnectorOauthService', () => {
  let connectors: { kindOf: Mock; requireAdmin: Mock; store: Mock };
  let redis: { set: Mock; getdel: Mock };
  let fetchFn: Mock;
  let config: Record<string, string>;
  let service: ConnectorOauthService;

  beforeEach(() => {
    connectors = {
      kindOf: vi.fn().mockImplementation((k: string) => k),
      requireAdmin: vi.fn().mockResolvedValue({ id: 'w1', organizationId: 'o1' }),
      store: vi.fn().mockResolvedValue({}),
    };
    redis = { set: vi.fn().mockResolvedValue('OK'), getdel: vi.fn().mockResolvedValue('verifier-1') };
    fetchFn = vi.fn();
    config = { SECRETS_ENCRYPTION_KEY: KEY_HEX, PUBLIC_API_URL: 'https://api.example.test', PUBLIC_APP_URL: 'https://app.example.test', LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 'cs' };
    const cfg = { getOrThrow: (k: string) => config[k], get: (k: string) => config[k] };
    service = new ConnectorOauthService(connectors as never, cfg as never, redis as never, { fetchFn: fetchFn as never });
  });

  const state = (over: Record<string, unknown> = {}) =>
    signState(secret, { u: 'u1', w: 'w1', k: 'linear', n: 'nonce1', e: Math.floor(Date.now() / 1000) + 300, ...over } as never);

  it('start requires an admin, stores the PKCE verifier by nonce and returns the signed authorize URL', async () => {
    const { url } = await service.start('u1', 'linear', 'w1');
    expect(connectors.requireAdmin).toHaveBeenCalledWith('u1', 'w1');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://linear.app/oauth/authorize');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://api.example.test/v1/connectors/linear/oauth/callback');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redis.set.mock.calls[0][0]).toMatch(/^connector:oauth:[0-9a-f]{32}$/);
    expect(redis.set.mock.calls[0][3]).toBe(600);
  });

  it('start is refused when the tool has no client id and secret', async () => {
    await expect(service.start('u1', 'sentry', 'w1')).rejects.toMatchObject({ response: { code: 'oauth_not_configured' } });
    expect(connectors.requireAdmin).not.toHaveBeenCalled();
  });

  it('callback exchanges the code, stores the sealed credential for the state user and redirects to the dashboard', async () => {
    fetchFn.mockResolvedValueOnce(json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'read' }));
    fetchFn.mockResolvedValueOnce(json({ data: { viewer: { name: 'Pat', organization: { name: 'Acme' } } } }));
    const target = await service.callback('linear', { code: 'abc', state: state() });
    expect(Object.fromEntries(fetchFn.mock.calls[0][1].body)).toMatchObject({ code: 'abc', code_verifier: 'verifier-1' });
    expect(connectors.store).toHaveBeenCalledWith('w1', 'linear', expect.objectContaining({ type: 'oauth', access: 'at' }), 'Acme', ['read'], 'u1');
    expect(target).toBe('https://app.example.test/connectors?kind=linear&status=connected');
  });

  it('callback rejects tampered, expired, wrong-kind and replayed state before any exchange', async () => {
    const bad = [state().replace(/.$/, 'x'), state({ e: 100 }), state({ k: 'figma' })];
    for (const s of bad) await expect(service.callback('linear', { code: 'c', state: s })).rejects.toMatchObject({ response: { code: 'invalid_state' } });
    redis.getdel.mockResolvedValueOnce(null);
    await expect(service.callback('linear', { code: 'c', state: state() })).rejects.toMatchObject({ response: { code: 'invalid_state' } });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(connectors.store).not.toHaveBeenCalled();
  });

  it('callback re-checks admin rights and reports failures through the redirect, storing nothing', async () => {
    connectors.requireAdmin.mockRejectedValueOnce(Object.assign(new Error('no'), { response: { code: 'forbidden' } }));
    expect(await service.callback('linear', { code: 'c', state: state() })).toBe('https://app.example.test/connectors?kind=linear&status=error&reason=forbidden');
    expect(await service.callback('linear', { error: 'access_denied', state: state() })).toContain('status=error&reason=denied');
    expect(connectors.store).not.toHaveBeenCalled();
  });
});
