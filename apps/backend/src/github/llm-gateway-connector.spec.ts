import { HttpException } from '@nestjs/common';
import { vi } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { connectorRuns } from '../database/schema';
import { LlmGatewayService } from './llm-gateway.service';

const TOKEN = 'connector-run-gateway-token';
const run = (over: Record<string, unknown> = {}) => ({
  id: 'crun-1',
  organizationId: 'org-1',
  agent: 'opencode',
  state: 'working',
  model: 'anthropic/claude-sonnet-5',
  gatewayTokenHash: hashToken(TOKEN),
  ...over,
});

function setup(row: Record<string, unknown> | null) {
  // GitHub runs never match; only the connector_runs table answers.
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: () => Promise.resolve(table === connectorRuns && row ? [row] : []) }) }) }),
  };
  const envs = { resolveBundle: vi.fn().mockResolvedValue({ vars: { ANTHROPIC_API_KEY: 'sk-real' } }) };
  const limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
  const fetchFn = vi.fn().mockResolvedValue(new Response('{"ok":1}', { status: 200 }));
  const service = new LlmGatewayService(db as never, envs as never, limits as never, { fetchFn: fetchFn as never });
  return { service, envs, fetchFn, limits };
}

const request = (over: Record<string, unknown> = {}) => ({
  provider: 'anthropic',
  path: 'messages',
  query: '',
  method: 'POST',
  headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
  body: Buffer.from('{}'),
  ...over,
});

const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
  return 200;
};

describe('LlmGatewayService for connector runs', () => {
  it('serves a live connector run with the organization key, which never reaches the caller', async () => {
    const { service, fetchFn, envs, limits } = setup(run());
    await service.forward(request());
    expect(envs.resolveBundle).toHaveBeenCalledWith('org-1', undefined, { agents: ['opencode'] });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-real');
    expect(limits.hit).toHaveBeenCalledWith('rl:llm-gw:crun-1', expect.any(Number), 3600);
  });

  it('refuses the token once the run has settled, so a leaked token dies with the run', async () => {
    for (const state of ['succeeded', 'failed', 'timed_out']) {
      expect(await status(setup(run({ state })).service.forward(request()))).toBe(401);
    }
  });

  it('refuses another provider than the run was started with, and a run with no model', async () => {
    expect(await status(setup(run()).service.forward(request({ provider: 'openai', path: 'responses' })))).toBe(401);
    expect(await status(setup(run({ model: null })).service.forward(request()))).toBe(401);
  });

  it('never lends a connector run a ChatGPT sign-in', async () => {
    expect(await status(setup(run({ model: 'chatgpt/gpt-5.5' })).service.forward(request({ provider: 'chatgpt', path: 'responses' })))).toBe(401);
  });

  it('refuses an unknown token', async () => {
    expect(await status(setup(null).service.forward(request()))).toBe(401);
  });
});
