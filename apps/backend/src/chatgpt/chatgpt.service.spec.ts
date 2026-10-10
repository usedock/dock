import { vi, type Mock } from 'vitest';
import { openValue } from '../environments/secrets';
import { CHATGPT_CLIENT_ID, ChatgptNotConnectedException, ChatgptService } from './chatgpt.service';

const USER = 'u1';
const KEY = 'ab'.repeat(32);

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

const ID_TOKEN = jwt({
  email: 'me@example.com',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' },
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Single-table fake: one connection row at most, enough for per-user state. */
function fakeDb() {
  const state: { row: Record<string, unknown> | null } = { row: null };
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => (state.row ? [{ ...state.row }] : []) }) }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            state.row = state.row ? { ...state.row, ...set } : { id: 'c1', createdAt: new Date(), ...values };
            return [{ ...state.row }];
          },
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if (state.row) state.row = { ...state.row, ...patch };
        },
      }),
    })),
    delete: vi.fn(() => ({
      where: () => ({
        returning: async () => {
          const had = state.row;
          state.row = null;
          return had ? [{ id: had.id }] : [];
        },
      }),
    })),
  };
  return { db, state };
}

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

function setup(env: Record<string, string> = { CHATGPT_SIGNIN_ENABLED: 'true' }) {
  const { db, state } = fakeDb();
  const redis = fakeRedis();
  const limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
  const fetchFn = vi.fn() as Mock;
  const config = { get: (k: string) => env[k], getOrThrow: () => KEY };
  const sleep = vi.fn(async () => undefined);
  const service = new ChatgptService(db as never, redis as never, limits as never, config as never, { fetchFn, sleep });
  return { service, db, state, redis, limits, fetchFn, sleep };
}

async function connect(ctx: ReturnType<typeof setup>, expiresIn = 3600) {
  ctx.fetchFn
    .mockResolvedValueOnce(json(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '5' }))
    .mockResolvedValueOnce(json(200, { authorization_code: 'code-1', code_verifier: 'ver-1' }))
    .mockResolvedValueOnce(json(200, { id_token: ID_TOKEN, access_token: 'access-1', refresh_token: 'refresh-1', expires_in: expiresIn }));
  await ctx.service.start(USER);
  return ctx.service.poll(USER);
}

describe('ChatgptService', () => {
  it('refuses to start when the instance has not opted in', async () => {
    const { service, fetchFn } = setup({});
    await expect(service.start(USER)).rejects.toMatchObject({ status: 403 });
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(service.usable(USER)).resolves.toBe(false);
  });

  it('opens a device code with the Codex client and remembers it per user', async () => {
    const { service, fetchFn, redis } = setup();
    fetchFn.mockResolvedValueOnce(json(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '7' }));
    const out = await service.start(USER);
    expect(out).toMatchObject({ userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', intervalSeconds: 7 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(init.body)).toEqual({ client_id: CHATGPT_CLIENT_ID });
    expect(JSON.parse(redis.store.get('chatgpt:device:u1')!)).toEqual({ deviceAuthId: 'dev-1', userCode: 'ABCD-1234' });
  });

  it('reports pending until the user approves, and expired without a code', async () => {
    const { service, fetchFn } = setup();
    await expect(service.poll(USER)).rejects.toMatchObject({ response: { code: 'device_code_expired' } });
    fetchFn.mockResolvedValueOnce(json(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234' }));
    await service.start(USER);
    fetchFn.mockResolvedValueOnce(json(403, {}));
    await expect(service.poll(USER)).resolves.toEqual({ state: 'pending' });
  });

  it('stores the approved sign-in sealed, with identity read from the id token', async () => {
    const ctx = setup();
    const out = await connect(ctx);
    expect(out).toMatchObject({ state: 'connected', status: 'active', connected: true, email: 'me@example.com', planType: 'plus' });
    const exchange = ctx.fetchFn.mock.calls[2];
    expect(exchange[0]).toBe('https://auth.openai.com/oauth/token');
    expect(new URLSearchParams(exchange[1].body).get('code_verifier')).toBe('ver-1');
    expect(JSON.stringify(ctx.state.row)).not.toContain('refresh-1');
    expect(JSON.parse(openValue(Buffer.from(KEY, 'hex'), ctx.state.row!.secret as never))).toEqual({ access: 'access-1', refresh: 'refresh-1' });
    expect(ctx.state.row!.accountId).toBe('acct-1');
    expect(ctx.redis.store.has('chatgpt:device:u1')).toBe(false);
    await expect(ctx.service.usable(USER)).resolves.toBe(true);
  });

  it('serves a live access token without calling OpenAI', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fetchFn.mockClear();
    await expect(ctx.service.accessFor(USER)).resolves.toEqual({ access: 'access-1', accountId: 'acct-1', residency: null });
    expect(ctx.fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes a stale token once across concurrent requests and keeps the rotated refresh token', async () => {
    const ctx = setup();
    await connect(ctx, 60);
    ctx.fetchFn.mockReset();
    ctx.fetchFn.mockResolvedValueOnce(json(200, { id_token: ID_TOKEN, access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }));
    const [a, b] = await Promise.all([ctx.service.accessFor(USER), ctx.service.accessFor(USER)]);
    expect(a.access).toBe('access-2');
    expect(b.access).toBe('access-2');
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(ctx.fetchFn.mock.calls[0][1].body).get('refresh_token')).toBe('refresh-1');
    expect(JSON.parse(openValue(Buffer.from(KEY, 'hex'), ctx.state.row!.secret as never)).refresh).toBe('refresh-2');
    expect(ctx.redis.store.has('chatgpt:refresh:u1')).toBe(false);
  });

  it('marks the sign-in expired when OpenAI refuses the refresh', async () => {
    const ctx = setup();
    await connect(ctx, 60);
    ctx.fetchFn.mockResolvedValueOnce(json(400, { error: 'invalid_grant' }));
    await expect(ctx.service.accessFor(USER)).rejects.toBeInstanceOf(ChatgptNotConnectedException);
    expect(ctx.state.row!.status).toBe('expired');
    await expect(ctx.service.usable(USER)).resolves.toBe(false);
    await expect(ctx.service.get(USER)).resolves.toMatchObject({ connected: true, status: 'expired' });
  });

  it('waits for another replica holding the refresh lock instead of replaying the refresh token', async () => {
    const ctx = setup();
    await connect(ctx, 60);
    ctx.fetchFn.mockClear();
    ctx.redis.store.set('chatgpt:refresh:u1', '1');
    ctx.sleep.mockImplementationOnce(async () => {
      ctx.state.row = { ...ctx.state.row, accessExpiresAt: new Date(Date.now() + 3600_000) };
    });
    await expect(ctx.service.accessFor(USER)).resolves.toMatchObject({ access: 'access-1' });
    expect(ctx.fetchFn).not.toHaveBeenCalled();
  });

  it('disconnects, and reports a missing sign-in as 404', async () => {
    const ctx = setup();
    await connect(ctx);
    await expect(ctx.service.remove(USER)).resolves.toMatchObject({ connected: false });
    await expect(ctx.service.remove(USER)).rejects.toBeInstanceOf(ChatgptNotConnectedException);
    await expect(ctx.service.accessFor(USER)).rejects.toBeInstanceOf(ChatgptNotConnectedException);
  });
});
