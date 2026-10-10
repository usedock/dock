import { HttpException } from '@nestjs/common';
import { hashToken } from '../crypto/tokens';
import { docks } from '../database/schema';
import { LlmGatewayController } from './llm-gateway.controller';
import { LlmGatewayService, type GatewayRequest } from './llm-gateway.service';
import { vi } from 'vitest';

const TOKEN = 'gw-run-token';
const liveRun = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  organizationId: 'org-1',
  agent: 'opencode',
  state: 'working',
  model: 'opencode-go/deepseek-v4.1-flash',
  gatewayTokenHash: hashToken(TOKEN),
  ...over,
});

function setup(
  run: Record<string, unknown> | null = liveRun(),
  opts: {
    allowed?: boolean;
    vars?: Record<string, string>;
    chatgpt?: { accessFor: ReturnType<typeof vi.fn> };
    dock?: Record<string, unknown>;
  } = {},
) {
  const lookups: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (w: unknown) => {
          lookups.push(w);
          const row = table === docks ? opts.dock : run;
          return { limit: () => Promise.resolve(row ? [row] : []) };
        },
      }),
    }),
  };
  const envs = { resolveBundle: vi.fn().mockResolvedValue({ vars: opts.vars ?? { OPENCODE_API_KEY: 'oc_real', ANTHROPIC_API_KEY: 'sk_real' } }) };
  const limits = { hit: vi.fn().mockResolvedValue({ allowed: opts.allowed ?? true, count: 1 }) };
  const fetchFn = vi.fn().mockResolvedValue(new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const service = new LlmGatewayService(db as never, envs as never, limits as never, { fetchFn: fetchFn as never }, opts.chatgpt as never);
  return { service, fetchFn, envs, limits, lookups };
}

const request = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
  provider: 'opencode-go',
  path: 'chat/completions',
  query: '',
  method: 'POST',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'user-agent': 'opencode/1.18.35',
    'x-opencode-session': 'ses_1',
    cookie: 'c=1',
    'x-forwarded-for': '10.0.0.1',
  },
  body: Buffer.from('{"model":"deepseek-v4.1-flash"}'),
  ...over,
});

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
  return 200;
}

describe('LlmGatewayService', () => {
  describe('chatgpt', () => {
    const chatgptRun = () => liveRun({ model: 'chatgpt/gpt-5.5', llmUserId: 'user-1' });
    const chatgptRequest = (over: Partial<GatewayRequest> = {}) =>
      request({ provider: 'chatgpt', path: 'responses', headers: { ...request().headers, 'chatgpt-account-id': 'spoofed' }, ...over });

    it("attaches the run user's ChatGPT token and account, never org provider keys", async () => {
      const chatgpt = { accessFor: vi.fn().mockResolvedValue({ access: 'cg_access', accountId: 'acct-1', residency: 'eu' }) };
      const ctx = setup(chatgptRun(), { chatgpt });
      await ctx.service.forward(chatgptRequest());
      const [url, init] = ctx.fetchFn.mock.calls[0];
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(init.headers).toMatchObject({
        authorization: 'Bearer cg_access',
        'chatgpt-account-id': 'acct-1',
        'x-openai-internal-codex-residency': 'eu',
      });
      expect(chatgpt.accessFor).toHaveBeenCalledWith('user-1');
      expect(ctx.envs.resolveBundle).not.toHaveBeenCalled();
    });

    it('drops a client-sent account id when the sign-in has none', async () => {
      const chatgpt = { accessFor: vi.fn().mockResolvedValue({ access: 'cg_access', accountId: null, residency: null }) };
      const ctx = setup(chatgptRun(), { chatgpt });
      await ctx.service.forward(chatgptRequest());
      expect(ctx.fetchFn.mock.calls[0][1].headers['chatgpt-account-id']).toBeUndefined();
    });

    it('reaches only the Responses endpoint', async () => {
      const chatgpt = { accessFor: vi.fn() };
      const ctx = setup(chatgptRun(), { chatgpt });
      expect(await status(ctx.service.forward(chatgptRequest({ path: 'wham/usage' })))).toBe(400);
      expect(chatgpt.accessFor).not.toHaveBeenCalled();
    });

    it('answers provider_not_configured when the run has no user or the sign-in is gone', async () => {
      const { ChatgptNotConnectedException } = await import('../chatgpt/chatgpt.service');
      const gone = { accessFor: vi.fn().mockRejectedValue(new ChatgptNotConnectedException()) };
      expect(await status(setup(chatgptRun(), { chatgpt: gone }).service.forward(chatgptRequest()))).toBe(503);
      const unused = { accessFor: vi.fn() };
      expect(await status(setup(liveRun({ model: 'chatgpt/gpt-5.5', llmUserId: null }), { chatgpt: unused }).service.forward(chatgptRequest()))).toBe(503);
      expect(unused.accessFor).not.toHaveBeenCalled();
    });

    it("serves a live dock's token on the chatgpt route as the dock's creator", async () => {
      const chatgpt = { accessFor: vi.fn().mockResolvedValue({ access: 'cg_access', accountId: 'acct-1', residency: null }) };
      const ctx = setup(null, { chatgpt, dock: { id: 'd1', state: 'running', createdBy: 'owner-1' } });
      await ctx.service.forward(chatgptRequest());
      expect(chatgpt.accessFor).toHaveBeenCalledWith('owner-1');
      expect(ctx.limits.hit).toHaveBeenCalledWith('rl:llm-gw:dock:d1', 2000, 3600);
    });

    it('refuses dock tokens on other providers and for stopped docks', async () => {
      const chatgpt = { accessFor: vi.fn() };
      const live = { id: 'd1', state: 'running', createdBy: 'owner-1' };
      expect(await status(setup(null, { chatgpt, dock: live }).service.forward(request({ provider: 'anthropic', path: 'messages' })))).toBe(401);
      expect(await status(setup(null, { chatgpt, dock: { ...live, state: 'archived' } }).service.forward(chatgptRequest()))).toBe(401);
      expect(chatgpt.accessFor).not.toHaveBeenCalled();
    });

    it('refuses a chatgpt route for a run on org keys', async () => {
      const ctx = setup(liveRun(), { chatgpt: { accessFor: vi.fn() } });
      expect(await status(ctx.service.forward(chatgptRequest()))).toBe(401);
    });
  });

  it('swaps the run token for the provider key and forwards client headers and body untouched', async () => {
    const ctx = setup();
    const res = await ctx.service.forward(request({ query: '?beta=true' }));
    expect(res.status).toBe(200);
    const [url, init] = ctx.fetchFn.mock.calls[0];
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions?beta=true');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'user-agent': 'opencode/1.18.35',
      'x-opencode-session': 'ses_1',
      authorization: 'Bearer oc_real',
    });
    expect(Buffer.from(init.body).toString()).toBe('{"model":"deepseek-v4.1-flash"}');
    expect(ctx.limits.hit).toHaveBeenCalledWith('rl:llm-gw:run-1', 2000, 3600);
  });

  it('accepts Anthropic-style x-api-key tokens and presents the key the same way', async () => {
    const ctx = setup(liveRun({ model: 'anthropic/claude-sonnet-5' }));
    await ctx.service.forward(request({ provider: 'anthropic', path: 'messages', headers: { 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' } }));
    const [url, init] = ctx.fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toEqual({ 'anthropic-version': '2023-06-01', 'x-api-key': 'sk_real' });
  });

  it('rejects missing tokens, unknown tokens, finished runs, and other providers', async () => {
    expect(await status(setup().service.forward(request({ headers: {} })))).toBe(401);
    expect(await status(setup(null).service.forward(request()))).toBe(401);
    for (const state of ['done', 'failed', 'stopped']) {
      expect(await status(setup(liveRun({ state })).service.forward(request()))).toBe(401);
    }
    const ctx = setup();
    expect(await status(ctx.service.forward(request({ provider: 'anthropic' })))).toBe(401);
    expect(ctx.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses traversal and odd paths before any upstream call', async () => {
    for (const path of ['../admin', 'a/../../b', 'chat completions', 'x?y']) {
      const ctx = setup();
      expect(await status(ctx.service.forward(request({ path })))).toBe(400);
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    }
  });

  it('enforces the per-run budget and fails closed without a provider key', async () => {
    expect(await status(setup(liveRun(), { allowed: false }).service.forward(request()))).toBe(429);
    expect(await status(setup(liveRun(), { vars: {} }).service.forward(request()))).toBe(503);
  });
});

describe('LlmGatewayController', () => {
  it('streams the upstream body through with status and content type', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\n\n'));
        controller.enqueue(encoder.encode('data: two\n\n'));
        controller.close();
      },
    });
    const gateway = { forward: vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) };
    const controller = new LlmGatewayController(gateway as never);
    const { PassThrough } = await import('node:stream');
    const res = Object.assign(new PassThrough(), {
      statusCode: 0,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      flushHeaders: vi.fn(),
    });
    const chunks: string[] = [];
    res.on('data', (c: Buffer) => chunks.push(c.toString()));
    const done = new Promise((r) => res.on('finish', r));
    await controller.proxy(
      'opencode-go',
      { params: { provider: 'opencode-go', path: ['chat', 'completions'] }, originalUrl: '/v1/llm/opencode-go/chat/completions?x=1', method: 'POST', headers: {}, body: Buffer.from('{}') } as never,
      res as never,
    );
    await done;
    expect(gateway.forward).toHaveBeenCalledWith(expect.objectContaining({ path: 'chat/completions', query: '?x=1', method: 'POST' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(chunks.join('')).toBe('data: one\n\ndata: two\n\n');
  });
});
