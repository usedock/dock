import { HttpException, HttpStatus } from '@nestjs/common';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { githubWebhookDeliveries } from '../database/schema';
import { GithubService } from './github.service';
import { vi } from 'vitest';

/** Pulls the column/value an `eq(...)` where-clause targets, for scoping assertions. */
function whereTarget(sqlExpr: unknown): { table: unknown; column: string; value: unknown } {
  const chunks = (sqlExpr as { queryChunks: unknown[] }).queryChunks;
  const col = chunks[1] as { name: string; table: unknown };
  const param = chunks[3] as { value: unknown };
  return { table: col.table, column: col.name, value: param.value };
}

const NOW = 1780000000000;
const KEY_HEX = 'a'.repeat(64);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CONFIG: Record<string, string> = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'dock',
  GITHUB_APP_PRIVATE_KEY: APP_KEY,
  GITHUB_APP_PRIVATE_KEY_PREV: '',
  GITHUB_APP_WEBHOOK_SECRET: 'whsec',
  GITHUB_APP_CLIENT_ID: 'Iv1.client',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  SECRETS_ENCRYPTION_KEY: KEY_HEX,
  FAST_RUN_ENABLED: 'true',
};

const mapping = {
  id: 'map-1',
  installationId: 99,
  workspaceId: 'ws-1',
  createdBy: 'user-1',
  repos: ['acme/web'],
  agent: 'opencode',
  testCommand: 'bun test',
};
const workspace = { id: 'ws-1', organizationId: 'org-1' };
const owner = { id: 'user-1', email: 'o@x.co', emailVerified: true, isInteractive: true };

const sign = (body: string): string =>
  `sha256=${createHmac('sha256', 'whsec').update(body).digest('hex')}`;

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'created',
  installation: { id: 99 },
  sender: { login: 'alice' },
  repository: { full_name: 'acme/web', name: 'web', owner: { login: 'acme' } },
  issue: { number: 42, title: 'Broken widget' },
  comment: { id: 1001, body: '@dock please fix', author_association: 'MEMBER' },
  ...over,
});

const deliveryFor = (body: unknown, over: Record<string, unknown> = {}) => {
  const raw = JSON.stringify(body);
  return {
    signature: sign(raw),
    deliveryGuid: 'guid-1',
    hookId: 'hook-1',
    event: 'issue_comment',
    rawBody: raw,
    body,
    ...over,
  };
};

const uniqueViolation = (): Error => Object.assign(new Error('dup'), { code: '23505' });

function scriptedDb() {
  const selectQueue: unknown[][] = [];
  const insertQueue: Array<unknown[] | Error> = [];
  const updateQueue: unknown[][] = [];
  const state = { inserts: [] as unknown[], sets: [] as unknown[], wheres: [] as unknown[], deletes: 0 };
  const whereChain = (rows: unknown[]) => ({
    limit: () => Promise.resolve(rows),
    orderBy: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
  });
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => whereChain(selectQueue.shift() ?? []) }) })),
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        state.inserts.push(v);
        return {
          returning: () => {
            const next = insertQueue.shift();
            if (next instanceof Error) return Promise.reject(next);
            return Promise.resolve(next ?? [{ ...(v as object) }]);
          },
        };
      },
    })),
    update: vi.fn(() => ({
      set: (s: unknown) => {
        state.sets.push(s);
        return {
          where: (w: unknown) => {
            state.wheres.push(w);
            return { returning: () => Promise.resolve(updateQueue.shift() ?? [{}]) };
          },
        };
      },
    })),
    delete: vi.fn(() => ({
      where: () => {
        state.deletes += 1;
        return Promise.resolve([]);
      },
    })),
  };
  return { db, selectQueue, insertQueue, updateQueue, state };
}
function setup(
  over: { timeoutMs?: number; leaseMs?: number } = {},
  extra: { envs?: unknown; completionToken?: string; metering?: unknown; spendGate?: unknown; fastRuns?: unknown; artifacts?: unknown } = {},
) {
  const { db, selectQueue, insertQueue, updateQueue, state } = scriptedDb();
  const orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
  const docks = {
    create: vi.fn().mockResolvedValue({ id: 'dock-1' }),
    stop: vi.fn().mockResolvedValue({ id: 'dock-1', state: 'archiving' }),
  };
  const limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
  const config = {
    get: vi.fn((key: string) => CONFIG[key]),
    getOrThrow: vi.fn((key: string) => {
      if (!(key in CONFIG)) throw new Error(`missing ${key}`);
      return CONFIG[key];
    }),
  };
  const api = {
    createIssueComment: vi.fn().mockResolvedValue({ id: 7 }),
    getBranchHead: vi.fn().mockResolvedValue({ sha: 'abc123' }),
    createPullRequest: vi.fn().mockResolvedValue({ number: 9, url: 'https://github.com/acme/web/pull/9' }),
    getRepoFile: vi.fn().mockResolvedValue({ content: null }),
    getCollaboratorPermission: vi.fn().mockResolvedValue({ permission: 'write' }),
    listInstallationRepositories: vi.fn().mockResolvedValue(['acme/web', 'Acme/Api']),
  };
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn((key: string, value: string) => Promise.resolve(void store.set(key, value))),
    del: vi.fn((key: string) => Promise.resolve(void store.delete(key))),
    getdel: vi.fn((key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    }),
  };
  const fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ token: 'ghs_secret_token', expires_at: '2026-09-08T19:00:00Z' }),
  });
  const service = new GithubService(
    db as never,
    orgs as never,
    docks as never,
    limits as never,
    config as never,
    api as never,
    {
      fetchFn: fetchFn as never,
      now: () => NOW,
      completionTokenFn: () => extra.completionToken ?? 'completion-plain-token',
      ...over,
    },
    extra.envs as never,
    extra.metering as never,
    extra.spendGate as never,
    extra.fastRuns as never,
    extra.artifacts as never,
    undefined,
    undefined,
    redis as never,
  );
  return { db, selectQueue, insertQueue, updateQueue, state, orgs, docks, limits, config, api, fetchFn, service, redis };
}

async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('expected rejection');
}

const runRow = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  installationId: 'map-1',
  workspaceId: 'ws-1',
  organizationId: 'org-1',
  repo: 'acme/web',
  issueNumber: 42,
  triggerCommentId: 1001,
  baseBranch: 'main',
  baseSha: 'abc123',
  branch: 'dock/run-run-1',
  testCommand: 'bun test',
  promptVersion: 'agent-prompt/v1',
  envelope: { issue: '# issue', system: 'system', constraints: 'constraints' },
  instructionFiles: [],
  state: 'pending',
  dockId: null,
  runtimeId: null,
  executionTarget: 'dock',
  requestedCapabilities: {},
  attemptNumber: 1,
  artifactStatus: 'pending',
  events: [{ t: 'run.created', at: new Date(NOW).toISOString() }],
  createdAt: new Date(NOW),
  ...over,
});

interface Acct {
  type: string;
  id: number;
  login: string;
}
interface GithubWorld {
  exchange?: boolean;
  userId?: number;
  installs?: Array<{ id: number; account: Acct }>;
  /** Account the App JWT lookup reports for installation 99; null means 404. */
  appAccount?: Acct | null;
  membership?: { state: string; role: string } | null;
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const no = (status: number) => ({ ok: false, status, json: () => Promise.resolve({}) });
const alice: Acct = { type: 'User', id: 7, login: 'alice' };
const acme: Acct = { type: 'Organization', id: 500, login: 'acme' };
const admin = { state: 'active', role: 'admin' };

/** Routes the GitHub calls the link flow makes; defaults describe a user who owns installation 99. */
function githubWorld(ctx: ReturnType<typeof setup>, w: GithubWorld = {}) {
  const installs = w.installs ?? [{ id: 99, account: alice }];
  const appAccount = w.appAccount === undefined ? (installs.find((i) => i.id === 99)?.account ?? null) : w.appAccount;
  ctx.fetchFn.mockImplementation((url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') return Promise.resolve(w.exchange === false ? ok({ error: 'bad_verification_code' }) : ok({ access_token: 'ghu_user' }));
    if (url === 'https://api.github.com/user') return Promise.resolve(ok({ id: w.userId ?? 7 }));
    if (url.startsWith('https://api.github.com/user/installations')) return Promise.resolve(ok({ installations: installs }));
    if (url === 'https://api.github.com/app/installations/99') return Promise.resolve(appAccount ? ok({ account: appAccount }) : no(404));
    if (url.startsWith('https://api.github.com/user/memberships/orgs/')) return Promise.resolve(w.membership ? ok(w.membership) : no(404));
    return Promise.resolve(ok({ token: 'ghs_list', expires_at: '' }));
  });
}
const CODE = 'oauthcode123';
async function linking(w: GithubWorld = {}) {
  const ctx = setup();
  ctx.selectQueue.push([workspace], [workspace], [workspace]);
  const started = await ctx.service.startInstallLink(owner as never, 'ws-1');
  githubWorld(ctx, w);
  return { ctx, state: started.state };
}

describe('GithubService installation linking', () => {
  it('start needs a session and org admin, then returns the App install URL and stores one pending link', async () => {
    const ctx = setup();
    ctx.selectQueue.push([workspace]);
    const { url, state } = await ctx.service.startInstallLink(owner as never, 'ws-1');
    expect(ctx.orgs.requireMembership).toHaveBeenCalledWith('org-1', 'user-1', 'admin');
    expect(url).toBe(`https://github.com/apps/dock/installations/new?state=${state}`);
    expect(ctx.redis.set).toHaveBeenCalledWith('gh:install:pending:user-1', JSON.stringify({ workspaceId: 'ws-1', nonce: state }), 'EX', 900);
    const denied = await catchErr(setup().service.startInstallLink({ ...owner, isInteractive: false } as never, 'ws-1'));
    expect(denied.body).toMatchObject({ code: 'session_required' });
  });

  it('links a user-owned installation, exchanging the code and never persisting the user token', async () => {
    const { ctx, state } = await linking();
    ctx.insertQueue.push([{ id: 'map-1', installationId: 99, workspaceId: 'ws-1', repos: ['acme/web', 'Acme/Api'] }]);
    const created = await ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state });
    expect(created).toMatchObject({ installationId: 99, workspaceId: 'ws-1' });
    const exchange = ctx.fetchFn.mock.calls.find((c) => c[0] === 'https://github.com/login/oauth/access_token')!;
    expect(JSON.parse(exchange[1].body)).toEqual({ client_id: 'Iv1.client', client_secret: 'client-secret', code: CODE });
    expect(ctx.state.inserts[0]).toMatchObject({ installationId: 99, workspaceId: 'ws-1', createdBy: 'user-1', repos: ['acme/web', 'Acme/Api'] });
    expect(JSON.stringify([ctx.state.inserts, ctx.redis.set.mock.calls])).not.toContain('ghu_user');
  });

  it('refuses a code without a matching state so a foreign OAuth code cannot complete the pending link', async () => {
    const { ctx, state } = await linking();
    const missing = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE }));
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'invalid_state' });
    expect(ctx.db.insert).not.toHaveBeenCalled();
    // The pending link was consumed, so even the right state cannot retry.
    const retry = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state }));
    expect(retry.body).toMatchObject({ code: 'invalid_state' });
  });

  it('links an organization installation when the user is an active org admin', async () => {
    const { ctx, state } = await linking({ installs: [{ id: 99, account: acme }], membership: admin });
    ctx.insertQueue.push([{ id: 'map-1', installationId: 99, workspaceId: 'ws-1', repos: [] }]);
    await ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state });
    expect(ctx.fetchFn.mock.calls.some((c) => c[0] === 'https://api.github.com/user/memberships/orgs/acme')).toBe(true);
  });

  it('answers every ownership failure with the same 403 and inserts nothing', async () => {
    const cases: GithubWorld[] = [
      { exchange: false },
      { installs: [{ id: 5, account: alice }], appAccount: alice },
      { installs: [{ id: 99, account: acme }], membership: { state: 'active', role: 'member' } },
      { installs: [{ id: 99, account: acme }], membership: { state: 'pending', role: 'admin' } },
      { installs: [{ id: 99, account: acme }], membership: null },
      { installs: [{ id: 99, account: { ...alice, id: 8 } }] },
      { appAccount: null },
    ];
    for (const world of cases) {
      const { ctx, state } = await linking(world);
      const err = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state }));
      expect(err.status).toBe(403);
      expect(err.body).toMatchObject({ code: 'installation_not_accessible' });
      expect(ctx.db.insert).not.toHaveBeenCalled();
    }
  });

  it('answers a duplicate exactly like an unverified installation', async () => {
    const { ctx, state } = await linking();
    ctx.insertQueue.push(uniqueViolation());
    const dup = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state }));
    expect(dup.status).toBe(403);
    expect(dup.body).toMatchObject({ code: 'installation_not_accessible' });
  });

  it('pending links are single use and bound to the user, and a wrong state is refused', async () => {
    const { ctx, state } = await linking();
    const other = await catchErr(ctx.service.completeInstallLink({ ...owner, id: 'user-2' } as never, { installationId: 99, code: CODE, state }));
    expect(other.body).toMatchObject({ code: 'invalid_state' });
    const wrong = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state: 'f'.repeat(32) }));
    expect(wrong.body).toMatchObject({ code: 'invalid_state' });
    // The wrong-state attempt consumed the link, so the real state cannot replay.
    const replay = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state }));
    expect(replay.body).toMatchObject({ code: 'invalid_state' });
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it('rejects when no link was started or it expired', async () => {
    const ctx = setup();
    const err = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state: 'a'.repeat(32) }));
    expect(err.body).toMatchObject({ code: 'invalid_state' });
  });

  it('without an installation id links the only controlled installation', async () => {
    const { ctx, state } = await linking({ installs: [{ id: 99, account: alice }, { id: 12, account: { ...alice, id: 8 } }] });
    ctx.insertQueue.push([{ id: 'map-1', installationId: 99, workspaceId: 'ws-1', repos: [] }]);
    const out = await ctx.service.completeInstallLink(owner as never, { code: CODE, state });
    expect(out).toMatchObject({ installationId: 99 });
  });

  it('without an installation id returns candidates, then links the pick once without a new code', async () => {
    const second: Acct = { ...acme, login: 'beta' };
    const { ctx, state } = await linking({ installs: [{ id: 99, account: alice }, { id: 12, account: second }], membership: admin });
    const out = await ctx.service.completeInstallLink(owner as never, { code: CODE, state });
    expect(out).toEqual({ candidates: [{ installationId: 99, account: 'alice' }, { installationId: 12, account: 'beta' }] });
    expect(ctx.db.insert).not.toHaveBeenCalled();
    ctx.selectQueue.push([workspace]);
    const stranger = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 777 }));
    expect(stranger.body).toMatchObject({ code: 'invalid_state' });
    // The failed pick consumed the offer, so offer again and pick a real candidate.
    const again = await linking({ installs: [{ id: 99, account: alice }, { id: 12, account: second }], membership: admin });
    await again.ctx.service.completeInstallLink(owner as never, { code: CODE, state: again.state });
    again.ctx.selectQueue.push([workspace]);
    again.ctx.insertQueue.push([{ id: 'map-1', installationId: 12, workspaceId: 'ws-1', repos: [] }]);
    const linked = await again.ctx.service.completeInstallLink(owner as never, { installationId: 12 });
    expect(linked).toMatchObject({ installationId: 12 });
    const replay = await catchErr(again.ctx.service.completeInstallLink(owner as never, { installationId: 12 }));
    expect(replay.body).toMatchObject({ code: 'invalid_state' });
  });

  it('re-checks org admin on the pick before inserting', async () => {
    const { ctx, state } = await linking({ installs: [{ id: 99, account: alice }, { id: 12, account: { ...acme, login: 'beta' } }], membership: admin });
    await ctx.service.completeInstallLink(owner as never, { code: CODE, state });
    ctx.selectQueue.push([workspace]);
    ctx.orgs.requireMembership.mockRejectedValueOnce(new HttpException({ code: 'forbidden' }, HttpStatus.FORBIDDEN));
    const err = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99 }));
    expect(err.status).toBe(403);
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it('leaves already-linked installations out of candidates and auto-link', async () => {
    const second: Acct = { ...acme, login: 'beta' };
    const installs = [{ id: 99, account: alice }, { id: 12, account: second }];
    const { ctx, state } = await linking({ installs, membership: admin });
    // Second remaining select is the linked-ids lookup: 12 is taken, so 99 is the only candidate and links directly.
    ctx.selectQueue.splice(1, 1, [{ installationId: 12 }]);
    ctx.insertQueue.push([{ id: 'map-1', installationId: 99, workspaceId: 'ws-1', repos: [] }]);
    const out = await ctx.service.completeInstallLink(owner as never, { code: CODE, state });
    expect(out).toMatchObject({ installationId: 99 });
    const all = await linking({ installs, membership: admin });
    all.ctx.selectQueue.splice(1, 1, [{ installationId: 99 }, { installationId: 12 }]);
    const none = await catchErr(all.ctx.service.completeInstallLink(owner as never, { code: CODE, state: all.state }));
    expect(none.body).toMatchObject({ code: 'installation_not_accessible' });
  });

  it('start in authorize mode returns the OAuth authorize URL with the same state, and needs the client id', async () => {
    const ctx = setup();
    ctx.selectQueue.push([workspace]);
    const { url, state } = await ctx.service.startInstallLink(owner as never, 'ws-1', 'authorize');
    expect(url).toBe(`https://github.com/login/oauth/authorize?client_id=Iv1.client&state=${state}`);
    expect(ctx.redis.set).toHaveBeenCalledWith('gh:install:pending:user-1', expect.stringContaining(state), 'EX', 900);
    const bare = setup();
    bare.selectQueue.push([workspace]);
    bare.config.get.mockImplementation((key: string) => (key === 'GITHUB_APP_CLIENT_ID' ? '' : CONFIG[key]));
    const err = await catchErr(bare.service.startInstallLink(owner as never, 'ws-1', 'authorize'));
    expect(err.body).toMatchObject({ code: 'github_app_oauth_not_configured' });
  });

  it('names the missing env when the App client credentials are not configured, keeping the pending link', async () => {
    const { ctx, state } = await linking();
    ctx.config.get.mockImplementation((key: string) => (key.startsWith('GITHUB_APP_CLIENT') ? '' : CONFIG[key]));
    const err = await catchErr(ctx.service.completeInstallLink(owner as never, { installationId: 99, code: CODE, state }));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'github_app_oauth_not_configured' });
    expect(ctx.redis.getdel).not.toHaveBeenCalled();
  });

  it('refuses service-key callers', async () => {
    const ctx = setup();
    const err = await catchErr(ctx.service.completeInstallLink({ ...owner, isInteractive: false } as never, { installationId: 99, code: CODE, state: 'a'.repeat(32) }));
    expect(err.body).toMatchObject({ code: 'session_required' });
  });

  it('narrows repos on PATCH to the installation, case-insensitively with GitHub casing', async () => {
    const ctx = setup();
    ctx.selectQueue.push([mapping], [workspace]);
    await ctx.service.updateInstallation(owner as never, 'map-1', { repos: ['ACME/api'] });
    expect(ctx.state.sets[0]).toMatchObject({ repos: ['Acme/Api'] });
    expect(JSON.parse(ctx.fetchFn.mock.calls[0][1].body)).toEqual({ permissions: { metadata: 'read' } });
  });

  it('rejects PATCH repos outside the installation without writing', async () => {
    const ctx = setup();
    ctx.selectQueue.push([mapping], [workspace]);
    const err = await catchErr(ctx.service.updateInstallation(owner as never, 'map-1', { repos: ['acme/web', 'victim/secret'] }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(ctx.db.update).not.toHaveBeenCalled();
  });
});

describe('GithubService webhook intake', () => {
  it('rejects bad signatures with 401 and claims nothing', async () => {
    const ctx = setup();
    const err = await catchErr(ctx.service.handleWebhookDelivery(deliveryFor(payload(), { signature: 'sha256=00' })));
    expect(err.status).toBe(401);
    expect(err.body).toMatchObject({ code: 'invalid_signature' });
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it('scopes the post-delivery status update to the claimed row, not the whole table', async () => {
    const ctx = setup();
    ctx.insertQueue.push([{ id: 'del-42' }]);
    const body = { action: 'deleted', installation: { id: 99 } };
    const raw = JSON.stringify(body);
    const out = await ctx.service.handleWebhookDelivery({
      signature: sign(raw),
      deliveryGuid: 'guid-7',
      hookId: 'hook-7',
      event: 'installation',
      rawBody: raw,
      body,
    });
    expect(out.status).toBe(200);
    // One scoped update from claimDelivery (-> processing), one from markDelivery (-> succeeded).
    expect(ctx.state.wheres).toHaveLength(2);
    for (const where of ctx.state.wheres) {
      const target = whereTarget(where);
      expect(target.table).toBe(githubWebhookDeliveries);
      expect(target.column).toBe('id');
      expect(target.value).toBe('del-42');
    }
    expect(ctx.state.sets[1]).toMatchObject({ status: 'succeeded' });
  });

  it('dedupes a redelivered GUID to the original run', async () => {
    const ctx = setup();
    ctx.insertQueue.push(uniqueViolation());
    ctx.selectQueue.push([{ id: 'del-1', status: 'succeeded', runId: 'run-9', updatedAt: new Date(NOW) }]);
    const out = await ctx.service.handleWebhookDelivery(deliveryFor(payload()));
    expect(out).toEqual({ status: 200, body: { received: true, duplicate: true, runId: 'run-9' } });
    expect(ctx.docks.create).not.toHaveBeenCalled();
    expect(ctx.api.createIssueComment).not.toHaveBeenCalled();
  });

  it('reclaims a stale processing claim and ignores unmapped repos', async () => {
    const ctx = setup({ leaseMs: 1000 });
    ctx.insertQueue.push(uniqueViolation());
    ctx.selectQueue.push([{ id: 'del-1', status: 'processing', runId: null, updatedAt: new Date(NOW - 60000) }], []);
    const out = await ctx.service.handleWebhookDelivery(deliveryFor(payload()));
    expect(out.body).toMatchObject({ received: true, ignored: true, reason: 'unmapped_repo' });
    expect(ctx.docks.create).not.toHaveBeenCalled();
  });

  it.each([
    ['unmapped installation', payload({ installation: { id: 404 } }), 'unmapped_repo', []],
    ['PR conversation comment', payload({ issue: { number: 42, pull_request: { url: 'x' } } }), 'pr_comment', [mapping]],
    ['code-block mention', payload({ comment: { id: 1002, body: '```\n@dock fix\n```' } }), 'no_mention', [mapping]],
    ['self comment', payload({ sender: { login: 'dock[bot]' } }), 'self_comment', [mapping]],
  ])('ignores %s without side effects', async (_name, body, reason, mappingRows) => {
    const ctx = setup();
    ctx.selectQueue.push(mappingRows as never);
    const out = await ctx.service.handleWebhookDelivery(deliveryFor(body));
    expect(out).toEqual({ status: 200, body: { received: true, ignored: true, reason } });
    expect(ctx.docks.create).not.toHaveBeenCalled();
    expect(ctx.api.createIssueComment).not.toHaveBeenCalled();
  });

  it('drops the mapping on installation.deleted', async () => {
    const ctx = setup();
    ctx.insertQueue.push([{ id: 'del-1' }]);
    const out = await ctx.service.handleWebhookDelivery(
      deliveryFor({ action: 'deleted', installation: { id: 99 } }, { event: 'installation' }),
    );
    expect(out.body).toMatchObject({ received: true, ignored: true, reason: 'installation_deleted' });
    expect(ctx.state.deletes).toBe(1);
  });
});

describe('GithubService run lifecycle', () => {
  it('rejects an invalid explicit execution target before creating a Run', async () => {
    const ctx = setup();
    ctx.selectQueue.push([mapping], [workspace], [], [], [], []);
    ctx.insertQueue.push([{ id: 'del-1' }]);
    const err = await catchErr(
      ctx.service.handleWebhookDelivery(deliveryFor(payload({ comment: { id: 1001, body: '@dock target:turbo fix this', author_association: 'MEMBER' } }))),
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(ctx.state.inserts).toHaveLength(1);
  });

  it('checks Fast Run billing before creating a branch or runtime', async () => {
    const spendGate = {
      requireFastRunSpend: vi.fn().mockRejectedValue(new HttpException({ code: 'budget_exceeded' }, HttpStatus.FORBIDDEN)),
    };
    const envs = { resolveBundle: vi.fn().mockResolvedValue({ vars: { ANTHROPIC_API_KEY: 'sk' } }) };
    const ctx = setup({}, { spendGate, envs });
    ctx.selectQueue.push([mapping], [workspace], [], [], [], []);
    ctx.insertQueue.push([{ id: 'del-1' }], [runRow()]);
    ctx.updateQueue.push([{ ...runRow(), state: 'failed', failureReason: 'budget_exceeded' }]);
    const out = await ctx.service.handleWebhookDelivery(
      deliveryFor(payload({ comment: { id: 1001, body: '@dock fast please fix this', author_association: 'MEMBER' } })),
    );
    expect(out.body).toMatchObject({ state: 'failed', reason: 'budget_exceeded' });
    expect(spendGate.requireFastRunSpend).toHaveBeenCalledWith('org-1', runRow().id);
    expect(ctx.docks.create).not.toHaveBeenCalled();
    expect(ctx.api.createPullRequest).not.toHaveBeenCalled();
  });
  it('keeps Fast Run disabled unless rollout configuration enables it', async () => {
    const ctx = setup();
    ctx.config.get.mockImplementation((key: string) => (key === 'FAST_RUN_ENABLED' ? 'false' : CONFIG[key]));
    ctx.selectQueue.push([mapping], [workspace], [], [], [], []);
    ctx.insertQueue.push([{ id: 'del-1' }]);
    const err = await catchErr(
      ctx.service.handleWebhookDelivery(deliveryFor(payload({ comment: { id: 1001, body: '@dock fast please fix this', author_association: 'MEMBER' } }))),
    );
    expect(err.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.body).toMatchObject({ code: 'fast_run_disabled' });
    expect(ctx.state.inserts).toHaveLength(1);
    expect(ctx.docks.create).not.toHaveBeenCalled();
  });

  it('rejects Fast Runs needing takeover before creating a runtime or branch', async () => {
    const fastRuns = { create: vi.fn(), terminate: vi.fn() };
    const ctx = setup({}, { fastRuns });
    ctx.selectQueue.push([mapping], [workspace], [], [], [], []);
    ctx.insertQueue.push([{ id: 'del-1' }], [runRow({ executionTarget: 'fast' })]);
    ctx.updateQueue.push([{ ...runRow(), state: 'failed', failureReason: 'capability_unavailable: sshTakeover' }]);
    const out = await ctx.service.handleWebhookDelivery(
      deliveryFor(payload({ comment: { id: 1001, body: '@dock fast needs ssh please fix this', author_association: 'MEMBER' } })),
    );
    expect(out.body).toMatchObject({ state: 'failed', reason: 'capability_unavailable: sshTakeover' });
    expect(fastRuns.create).not.toHaveBeenCalled();
    expect(ctx.docks.create).not.toHaveBeenCalled();
    expect(ctx.api.createPullRequest).not.toHaveBeenCalled();
  });

  it('fails closed with no dock when the token mint is refused', async () => {
    const ctx = setup();
    ctx.selectQueue.push([mapping], [workspace], [], [], [], []);
    ctx.insertQueue.push([{ id: 'del-1' }], [runRow()]);
    ctx.updateQueue.push([{ ...runRow(), state: 'failed', failureReason: 'token_mint_failed' }]);
    // The first mint serves the permission check; the run's own mint is the one refused.
    ctx.fetchFn
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'ghs_perm', expires_at: '2026-09-08T19:00:00Z' }) })
      .mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const out = await ctx.service.handleWebhookDelivery(deliveryFor(payload()));
    expect(out.body).toMatchObject({ runId: 'run-1', state: 'failed', reason: 'token_mint_failed' });
    expect(ctx.docks.create).not.toHaveBeenCalled();
    // Commenting needs the same mint, so no issue comment is possible; the failure shows in GET runs.
    expect(ctx.api.createIssueComment).not.toHaveBeenCalled();
  });
  it('serializes a second mention on one issue to a busy comment', async () => {
    const ctx = setup();
    ctx.selectQueue.push([mapping], [workspace], [{ ...runRow(), id: 'run-busy', state: 'working' }]);
    ctx.insertQueue.push([{ id: 'del-1' }]);
    const out = await ctx.service.handleWebhookDelivery(deliveryFor(payload({ comment: { id: 1002, body: '@dock again', author_association: 'MEMBER' } })));
    expect(out.body).toMatchObject({ busy: true, runId: 'run-busy' });
    expect(ctx.docks.create).not.toHaveBeenCalled();
    const comment = (ctx.api.createIssueComment.mock.calls[0][0] as { body: string }).body;
    expect(comment).toContain('run-busy');
  });

  it('records timed_out without provisioning when the run exceeds its bound', async () => {
    const ctx = setup({ timeoutMs: 1 });
    ctx.selectQueue.push([mapping], [workspace], [], [], [], []);
    ctx.insertQueue.push([{ id: 'del-1' }], [runRow({ createdAt: new Date(NOW - 60000) })]);
    ctx.updateQueue.push([{ ...runRow(), state: 'failed', failureReason: 'timed_out' }]);
    const out = await ctx.service.handleWebhookDelivery(deliveryFor(payload()));
    expect(out.body).toMatchObject({ state: 'failed', reason: 'timed_out' });
    expect(ctx.docks.create).not.toHaveBeenCalled();
  });
});

describe('GithubService limits and reads', () => {
  it('maps rate exhaustion to 429 with a throttled comment and no run', async () => {
    const ctx = setup();
    ctx.selectQueue.push([mapping], [workspace]);
    ctx.insertQueue.push([{ id: 'del-1' }]);
    ctx.limits.hit.mockResolvedValue({ allowed: false, count: 11 });
    const err = await catchErr(ctx.service.handleWebhookDelivery(deliveryFor(payload())));
    expect(err.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.body).toMatchObject({ code: 'rate_limited' });
    expect(ctx.api.createIssueComment).toHaveBeenCalledTimes(1);
    expect(ctx.state.inserts).toHaveLength(1);
  });

  it('hides run existence from non-members as run_not_found', async () => {
    const ctx = setup();
    ctx.selectQueue.push([runRow()], [workspace]);
    ctx.orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const err = await catchErr(ctx.service.getRun('stranger', 'run-1'));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'run_not_found' });
  });

  it('lists runs for members in workspace scope', async () => {
    const ctx = setup();
    ctx.selectQueue.push([workspace], [runRow()]);
    const rows = await ctx.service.listRuns('user-1', 'ws-1');
    expect(rows).toHaveLength(1);
    expect(ctx.orgs.requireMembership).toHaveBeenCalledWith('org-1', 'user-1');
  });

  it('returns the run view, not the row, from list and get', async () => {
    const ctx = setup();
    const secret = { sealedToken: { ct: 'sealed-x' }, completionTokenHash: 'hash-x', envelopeHash: 'env-x' };
    ctx.selectQueue.push([workspace], [runRow(secret)], [runRow(secret)], [workspace]);
    const out = [await ctx.service.listRuns('user-1', 'ws-1'), await ctx.service.getRun('user-1', 'run-1')];
    const json = JSON.stringify(out);
    for (const leaked of ['sealed-x', 'hash-x', 'env-x', 'envelope', 'attemptNumber']) expect(json).not.toContain(leaked);
    expect(out[1]).toMatchObject({ id: 'run-1', repo: 'acme/web' });
  });
});
