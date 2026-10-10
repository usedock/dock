import { createHmac, generateKeyPairSync } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { hashToken } from '../crypto/tokens';
import { account, githubInstallations, githubRuns, githubWebhookDeliveries, workspaces } from '../database/schema';
import { DEFAULT_RUN_EGRESS, GithubService } from './github.service';
import { vi } from 'vitest';

const NOW = 1780000000000;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const COMPLETION_PLAIN = 'completion-plain-token';
const GATEWAY_PLAIN = 'gateway-plain-token';

/** Every base64 payload a script writes, decoded. */
function payloads(script: string): string[] {
  return [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)'/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
}

const BASE_CONFIG: Record<string, string> = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'dock',
  GITHUB_APP_PRIVATE_KEY: APP_KEY,
  GITHUB_APP_PRIVATE_KEY_PREV: '',
  GITHUB_APP_WEBHOOK_SECRET: 'whsec',
  FAST_RUN_ENABLED: 'true',
};

const MAPPING = {
  id: 'map-1',
  installationId: 99,
  workspaceId: 'ws-1',
  createdBy: 'user-1',
  repos: ['acme/web'],
  agent: 'opencode',
  testCommand: 'bun test',
};

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'created',
  installation: { id: 99 },
  sender: { login: 'alice' },
  repository: { full_name: 'acme/web', name: 'web', default_branch: 'trunk', owner: { login: 'acme' } },
  issue: { number: 42, title: 'Broken widget', body: 'it breaks' },
  comment: { id: 1001, body: '@dock please fix', author_association: 'MEMBER' },
  ...over,
});

const delivery = (body: unknown, guid = 'guid-1') => {
  const raw = JSON.stringify(body);
  return {
    signature: `sha256=${createHmac('sha256', 'whsec').update(raw).digest('hex')}`,
    deliveryGuid: guid,
    hookId: 'hook-1',
    event: 'issue_comment',
    rawBody: raw,
    body,
  };
};

/** (column, value) pairs of every `eq(...)` in a where clause, through `and(...)`. */
function eqPairs(sql: unknown, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  const chunks = (sql as { queryChunks?: unknown[] })?.queryChunks;
  if (!chunks) return out;
  const col = chunks[1] as { name?: string } | undefined;
  const param = chunks[3] as { value?: unknown } | undefined;
  const op = String((chunks[2] as { value?: unknown })?.value ?? '');
  if (chunks.length === 5 && col?.name && param && 'value' in param && op.trim() === '=') {
    out.push([col.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), param.value]);
  } else {
    for (const c of chunks) if ((c as { queryChunks?: unknown })?.queryChunks) eqPairs(c, out);
  }
  return out;
}

/** In-memory tables: run rows persist across calls so async launch and completion compose. */
function fakeDb(mapping: Record<string, unknown> | null, githubLink: { userId: string } | null = null) {
  const runs = new Map<string, Record<string, unknown>>();
  const matching = (where: unknown) => {
    const pairs = eqPairs(where);
    return [...runs.values()].filter((r) => pairs.every(([k, v]) => r[k] === v));
  };
  const chain = (rows: unknown[]) => {
    const out = Promise.resolve(rows);
    return { limit: () => out, orderBy: () => out, returning: () => out, then: out.then.bind(out) };
  };
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          if (table === githubInstallations) return chain(mapping ? [mapping] : []);
          if (table === workspaces) return chain([{ id: 'ws-1', organizationId: 'org-1' }]);
          if (table === account) return chain(githubLink ? [githubLink] : []);
          if (table !== githubRuns) return chain([]);
          // The sweep filters by state lists and time, which eq-matching cannot see.
          if (!eqPairs(where).length) return chain([...runs.values()].filter((r) => ['provisioning', 'working', 'pr_opened'].includes(String(r.state))));
          return chain(matching(where));
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          if (table === githubRuns) {
            const row = { id: 'run-1', attemptNumber: 1, runtimeId: null, runtimeHostId: null, dockId: null, createdAt: new Date(NOW), ...v };
            runs.set('run-1', row);
            return Promise.resolve([row]);
          }
          return Promise.resolve([{ id: table === githubWebhookDeliveries ? 'del-1' : 'x', ...v }]);
        },
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: unknown) => {
          if (table !== githubRuns) return chain([{}]);
          return chain(
            matching(where).map((r) => {
              const next = { ...r, ...patch };
              runs.set(String(r.id), next);
              return next;
            }),
          );
        },
      }),
    })),
    delete: vi.fn(() => ({ where: () => Promise.resolve([]) })),
  };
  return { db, runs };
}

interface SetupOptions {
  config?: Record<string, string>;
  mapping?: Record<string, unknown>;
  vars?: Record<string, string>;
  bundleFails?: boolean;
  dock?: Record<string, unknown>;
  host?: { id: string } | null;
  timeoutMs?: number;
  /** Commenter's Dock account linked through GitHub sign-in, and their ChatGPT state. */
  chatgpt?: { linkedUser: string | null; usable: boolean; member?: boolean };
}

function setup(opts: SetupOptions = {}) {
  const config = { ...BASE_CONFIG, ...opts.config };
  const mapping = { ...MAPPING, ...opts.mapping };
  const { db, runs } = fakeDb(mapping, opts.chatgpt?.linkedUser ? { userId: opts.chatgpt.linkedUser } : null);
  const chatgpt = opts.chatgpt ? { enabled: true, usable: vi.fn().mockResolvedValue(opts.chatgpt.usable) } : undefined;
  const requireMembership = vi.fn((_org: string, userId: string) =>
    opts.chatgpt?.member === false && userId === opts.chatgpt.linkedUser ? Promise.reject(new Error('not a member')) : Promise.resolve({ role: 'admin' }),
  );
  const docks = {
    create: vi.fn().mockResolvedValue({ id: 'dock-1', hostId: 'host-7', ...opts.dock }),
    stop: vi.fn().mockResolvedValue({ id: 'dock-1', state: 'archiving' }),
  };
  const api = {
    createIssueComment: vi.fn().mockResolvedValue({ id: 7 }),
    getBranchHead: vi.fn().mockResolvedValue({ sha: 'abc123' }),
    createPullRequest: vi.fn().mockResolvedValue({ number: 9, url: 'https://github.com/acme/web/pull/9' }),
    getRepoFile: vi.fn().mockResolvedValue({ content: null }),
    getCollaboratorPermission: vi.fn().mockResolvedValue({ permission: 'write' }),
    getCommitTree: vi.fn().mockResolvedValue({ treeSha: 'tree-base' }),
    createBlob: vi.fn().mockImplementation(({ contentBase64 }: { contentBase64: string }) => Promise.resolve({ sha: `blob-${contentBase64}` })),
    createTree: vi.fn().mockResolvedValue({ sha: 'tree-new' }),
    createCommit: vi.fn().mockResolvedValue({ sha: 'commit-new' }),
    setBranch: vi.fn().mockResolvedValue(undefined),
  };
  const envs = {
    resolveBundle: opts.bundleFails
      ? vi.fn().mockRejectedValue(new Error('withheld'))
      : vi.fn().mockResolvedValue({ vars: opts.vars ?? { ANTHROPIC_API_KEY: 'sk-ant' } }),
  };
  const spendGate = {
    requireSpend: vi.fn().mockResolvedValue(undefined),
    requireFastRunSpend: vi.fn().mockResolvedValue(undefined),
  };
  const metering = {
    openFastRunWindow: vi.fn().mockResolvedValue(undefined),
    closeWindowsForRuntime: vi.fn().mockResolvedValue(undefined),
  };
  const fastRuns = {
    create: vi.fn().mockResolvedValue({ runtimeId: 'run-1', hostId: 'host-3', ip: '10.0.0.5', capabilities: {} }),
    exec: vi.fn().mockResolvedValue({ runtimeId: 'x', exitCode: 0, stdout: '', stderr: '' }),
    read: vi.fn(),
    collectArtifacts: vi.fn().mockResolvedValue({ '/run/dock-fast/RESULT.json': '{"status":"fixed"}' }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
  const artifacts = { publish: vi.fn().mockResolvedValue([]) };
  const hosts = { placeForDock: vi.fn().mockResolvedValue(opts.host === undefined ? { id: 'host-3' } : opts.host) };
  const fetchFn = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
    const readOnly = JSON.parse(init.body).permissions?.contents === 'read';
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: readOnly ? 'ghs_read_only' : 'ghs_secret_token', expires_at: '2026-09-08T19:00:00Z' }) });
  });
  const service = new GithubService(
    db as never,
    { requireMembership } as never,
    docks as never,
    { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) } as never,
    { get: vi.fn((key: string) => config[key]), getOrThrow: vi.fn((key: string) => config[key]) } as never,
    api as never,
    { fetchFn: fetchFn as never, now: () => NOW, completionTokenFn: () => COMPLETION_PLAIN, gatewayTokenFn: () => GATEWAY_PLAIN, timeoutMs: opts.timeoutMs },
    envs as never,
    metering as never,
    spendGate as never,
    fastRuns as never,
    artifacts as never,
    hosts as never,
    chatgpt as never,
  );
  const comments = () => api.createIssueComment.mock.calls.map(([c]) => (c as { body: string }).body);
  const launched = () => {
    const [ref, prepare, , prepareToken, prepareEnv] = fastRuns.exec.mock.calls[0];
    const [launchRef, launch, , launchToken, launchEnv] = fastRuns.exec.mock.calls[1] ?? [];
    const decoded = payloads(String(prepare));
    return {
      ref,
      launchRef,
      prepare: String(prepare),
      launch: String(launch),
      runner: decoded.find((d) => d.includes('STAGE=agent_missing')) ?? '',
      config: JSON.parse(decoded.find((d) => d.includes('"dock-fix"')) ?? '{}'),
      prepareToken,
      prepareEnv,
      launchToken,
      launchEnv,
    };
  };
  const mints = () => fetchFn.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body).permissions ?? null);
  return { service, runs, docks, api, envs, metering, spendGate, fastRuns, artifacts, hosts, chatgpt, comments, launched, mints };
}

async function mention(ctx: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  const out = await ctx.service.handleWebhookDelivery(delivery(payload(over)));
  await ctx.service.settled();
  return out;
}

async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
  throw new Error('expected rejection');
}

const liveRun = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  installationId: 'map-1',
  workspaceId: 'ws-1',
  organizationId: 'org-1',
  repo: 'acme/web',
  issueNumber: 42,
  baseBranch: 'main',
  baseSha: 'abc123',
  branch: 'dock/run-run-1',
  agent: 'opencode',
  testCommand: 'bun test',
  promptVersion: 'agent-prompt/v2',
  envelope: { issue: '# issue', system: 'system', constraints: 'constraints' },
  instructionFiles: [],
  executionTarget: 'dock',
  attemptNumber: 1,
  completionTokenHash: hashToken(COMPLETION_PLAIN),
  completionConsumed: false,
  completionStatus: null,
  state: 'working',
  dockId: 'dock-1',
  runtimeId: null,
  runtimeHostId: 'host-7',
  prNumber: null,
  prUrl: null,
  events: [],
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  ...over,
});

describe('mention intake', () => {
  it('ignores unprivileged and missing author associations without a run', async () => {
    for (const association of ['CONTRIBUTOR', undefined]) {
      const ctx = setup();
      const out = await mention(ctx, { comment: { id: 1001, body: '@dock fix', author_association: association } });
      expect(out.body).toMatchObject({ ignored: true, reason: 'unprivileged_sender' });
      expect(ctx.runs.size).toBe(0);
    }
  });

  it('ignores a commenter without write permission even when the association looks trusted', async () => {
    for (const permission of ['read', 'triage', 'none']) {
      const ctx = setup();
      ctx.api.getCollaboratorPermission.mockResolvedValue({ permission });
      const out = await mention(ctx, {});
      expect(out.body).toMatchObject({ ignored: true, reason: 'unprivileged_sender' });
      expect(ctx.api.getCollaboratorPermission).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', repo: 'web', username: 'alice' }));
      expect(ctx.runs.size).toBe(0);
    }
  });

  it('allows maintain and admin permissions to start a run', async () => {
    for (const permission of ['maintain', 'admin']) {
      const ctx = setup();
      ctx.api.getCollaboratorPermission.mockResolvedValue({ permission });
      const out = await mention(ctx, {});
      expect(out.body).toMatchObject({ runId: 'run-1' });
    }
  });

  it('fails closed when the permission lookup errors', async () => {
    const ctx = setup();
    ctx.api.getCollaboratorPermission.mockRejectedValue(new Error('boom'));
    const out = await mention(ctx, {});
    expect(out.body).toMatchObject({ ignored: true, reason: 'unprivileged_sender' });
    expect(ctx.runs.size).toBe(0);
  });

  it('answers 202 before provisioning and opens no PR until a fix is pushed', async () => {
    const ctx = setup();
    const out = await ctx.service.handleWebhookDelivery(delivery(payload()));
    expect(out).toMatchObject({ status: 202, body: { runId: 'run-1', state: 'provisioning' } });
    await ctx.service.settled();
    expect(ctx.api.createPullRequest).not.toHaveBeenCalled();
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'working', dockId: 'dock-1', runtimeHostId: 'host-7' });
  });
});

describe('persistent dock launch', () => {
  it('boots a confined agent dock, clones with a read-only token, and launches with run-scoped secrets only', async () => {
    const ctx = setup();
    await mention(ctx);
    const [caller, input, key] = ctx.docks.create.mock.calls[0];
    expect(caller).toBe('user-1');
    expect(input).toMatchObject({ workspaceId: 'ws-1', ttlSeconds: 3600 });
    expect(input.egressAllow).toEqual([...DEFAULT_RUN_EGRESS, 'api.usedock.io']);
    expect(key).toBe('run:run-1:provision:1');
    expect(ctx.mints()).toContainEqual({ contents: 'read' });
    const run = ctx.launched();
    expect(run.ref).toEqual({ hostId: 'host-7', runtimeId: 'dock-1' });
    expect(run.launchRef).toEqual(run.ref);
    expect(run.prepareToken).toBe('run:run-1:prepare:1');
    expect(run.prepareEnv).toEqual({ GITHUB_CLONE_TOKEN: 'ghs_read_only' });
    expect(run.launchToken).toBe('run:run-1:launch:1');
    expect(run.launchEnv).toEqual({ GITHUB_COMPLETION_TOKEN: COMPLETION_PLAIN, DOCK_LLM_TOKEN: GATEWAY_PLAIN });
    expect(run.prepare).toContain("--branch 'trunk'");
    expect(run.runner).toContain("--model 'anthropic/claude-sonnet-5'");
    expect(run.runner).toContain("CALLBACK_URL='https://api.usedock.io/v1/github/runs/run-1/complete'");
    expect(run.config.provider).toEqual({ anthropic: { options: { baseURL: 'https://api.usedock.io/v1/llm/anthropic', apiKey: '{env:DOCK_LLM_TOKEN}' } } });
    for (const secret of ['sk-ant', 'ghs_secret_token', 'ghs_read_only', COMPLETION_PLAIN, GATEWAY_PLAIN]) {
      expect(run.prepare).not.toContain(secret);
      expect(run.launch).not.toContain(secret);
    }
  });

  it('points callbacks, the LLM gateway, and egress at PUBLIC_API_URL on a self-hosted instance', async () => {
    const ctx = setup({ config: { PUBLIC_API_URL: 'https://api.dock.example.com', PUBLIC_APP_URL: 'https://dock.example.com' } });
    await mention(ctx);
    expect(ctx.docks.create.mock.calls[0][1].egressAllow).toEqual([...DEFAULT_RUN_EGRESS, 'api.dock.example.com']);
    const run = ctx.launched();
    expect(run.runner).toContain("CALLBACK_URL='https://api.dock.example.com/v1/github/runs/run-1/complete'");
    expect(JSON.stringify(run.config)).not.toContain('usedock.io');
  });

  it('honors RUN_EGRESS_ALLOW and `*` to leave egress open', async () => {
    const custom = setup({ config: { RUN_EGRESS_ALLOW: 'github.com, pypi.org' } });
    await mention(custom);
    expect(custom.docks.create.mock.calls[0][1].egressAllow).toEqual(['github.com', 'pypi.org', 'api.usedock.io']);
    const open = setup({ config: { RUN_EGRESS_ALLOW: '*' } });
    await mention(open);
    expect(open.docks.create.mock.calls[0][1].egressAllow).toBeUndefined();
  });

  it('fails clone_failed when the prepare exec fails, before launching', async () => {
    const ctx = setup();
    ctx.fastRuns.exec.mockResolvedValueOnce({ runtimeId: 'x', exitCode: 128, stdout: '', stderr: 'fatal: repository not found' });
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'clone_failed' });
    expect(ctx.fastRuns.exec).toHaveBeenCalledTimes(1);
  });

  it('stores the envelope, branch, and only the completion token hash', async () => {
    const ctx = setup();
    await mention(ctx, { issue: { number: 42, title: 'Bug', body: 'visible​ text<div>hidden</div>' } });
    const run = ctx.runs.get('run-1')!;
    expect(run).toMatchObject({ baseSha: 'abc123', branch: 'dock/run-run-1', testCommand: 'bun test', promptVersion: 'agent-prompt/v2' });
    expect(run.completionTokenHash).toBe(hashToken(COMPLETION_PLAIN));
    expect(run.gatewayTokenHash).toBe(hashToken(GATEWAY_PLAIN));
    expect(run.model).toBe('anthropic/claude-sonnet-5');
    expect(JSON.stringify(run)).not.toContain(COMPLETION_PLAIN);
    expect(JSON.stringify(run)).not.toContain(GATEWAY_PLAIN);
    const issue = (run.envelope as { issue: string }).issue;
    expect(issue).toContain('visible texthidden');
    expect(issue).not.toContain('​');
  });

  it('honors GITHUB_RUN_MODEL and an OpenAI-only bundle', async () => {
    const override = setup({ config: { GITHUB_RUN_MODEL: 'anthropic/claude-opus-5-5' } });
    await mention(override);
    expect(override.launched().runner).toContain("--model 'anthropic/claude-opus-5-5'");
    const openai = setup({ vars: { OPENAI_API_KEY: 'sk-oa' } });
    await mention(openai);
    expect(openai.launched().runner).toContain("--model 'openai/gpt-5'");
  });

  it("runs on the commenter's own ChatGPT sign-in through the gateway, even with no org keys", async () => {
    const ctx = setup({ vars: {}, chatgpt: { linkedUser: 'user-9', usable: true } });
    await mention(ctx, { sender: { login: 'alice', id: 555 } });
    expect(ctx.runs.get('run-1')).toMatchObject({ model: 'chatgpt/gpt-5.5', llmUserId: 'user-9' });
    const { runner, config, launchEnv } = ctx.launched();
    expect(runner).toContain("--model 'openai/gpt-5.5'");
    expect(runner).toContain('OPENCODE_AUTH_CONTENT=');
    expect(config.provider).toEqual({ openai: { options: { baseURL: 'https://api.usedock.io/v1/llm/chatgpt' } } });
    expect(Object.keys(launchEnv)).toEqual(['GITHUB_COMPLETION_TOKEN', 'DOCK_LLM_TOKEN']);
    expect(ctx.chatgpt!.usable).toHaveBeenCalledWith('user-9');
  });

  it('falls back to org keys for commenters unknown to Dock or outside the org', async () => {
    for (const chatgpt of [{ linkedUser: null, usable: true }, { linkedUser: 'user-9', usable: true, member: false }, { linkedUser: 'user-9', usable: false }]) {
      const ctx = setup({ chatgpt });
      await mention(ctx, { sender: { login: 'alice', id: 555 } });
      expect(ctx.runs.get('run-1')).toMatchObject({ model: 'anthropic/claude-sonnet-5', llmUserId: null });
    }
  });

  it('fails launch_failed and stops the dock when the launch exec fails', async () => {
    const ctx = setup();
    ctx.fastRuns.exec.mockResolvedValueOnce({ runtimeId: 'x', exitCode: 0, stdout: '', stderr: '' }).mockRejectedValueOnce(new Error('host_timeout'));
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'launch_failed' });
    expect(ctx.docks.stop).toHaveBeenCalledWith('user-1', 'dock-1', {});
  });

  it('fails dock_provision_failed when the dock cannot boot', async () => {
    const ctx = setup();
    ctx.docks.create.mockRejectedValue(new Error('no capacity'));
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'dock_provision_failed' });
    expect(ctx.fastRuns.exec).not.toHaveBeenCalled();
  });
});

describe('fast run launch', () => {
  it('places by size on a fleet host, sends resources and image, and opens billing', async () => {
    const ctx = setup({ config: { RUNTIME_DRIVER: 'restate' } });
    await mention(ctx, { comment: { id: 1001, body: '@dock fast fix it', author_association: 'OWNER' } });
    expect(ctx.hosts.placeForDock).toHaveBeenCalledWith({ cpus: 2, memoryMiB: 4096 });
    const input = ctx.fastRuns.create.mock.calls[0][0];
    expect(input.hostId).toBe('host-3');
    expect(input.resources).toEqual({ cpus: 2, memoryMiB: 4096, diskGiB: 20 });
    expect(input.image).toBe('ubuntu-24.04');
    expect(Object.keys(input).sort()).toEqual(['capabilities', 'egressAllow', 'hostId', 'image', 'resources', 'runtimeId']);
    expect(input.egressAllow).toContain('registry.npmjs.org');
    expect(ctx.docks.create).not.toHaveBeenCalled();
    expect(ctx.launched().ref).toEqual({ hostId: 'host-3', runtimeId: 'run-1' });
    expect(ctx.metering.openFastRunWindow).toHaveBeenCalledWith({ organizationId: 'org-1', workspaceId: 'ws-1', runtimeId: 'run-1' });
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'working', executionTarget: 'fast', runtimeId: 'run-1', runtimeHostId: 'host-3' });
  });

  it('fails fast_runtime_create_failed when no fleet host has capacity', async () => {
    const ctx = setup({ config: { RUNTIME_DRIVER: 'restate' }, host: null });
    await mention(ctx, { comment: { id: 1001, body: '@dock fast', author_association: 'OWNER' } });
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'fast_runtime_create_failed' });
    expect(ctx.fastRuns.create).not.toHaveBeenCalled();
  });
});

describe('pre-launch failures', () => {
  it('fails no_test_command when nothing is configured or detected', async () => {
    const ctx = setup({ mapping: { testCommand: null } });
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'no_test_command' });
    expect(ctx.docks.create).not.toHaveBeenCalled();
  });

  it('auto-detects the test command from repo instruction files', async () => {
    const ctx = setup({ mapping: { testCommand: null } });
    ctx.api.getRepoFile.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({ content: path === 'AGENTS.md' ? 'Run `go test ./...` before committing.' : null }),
    );
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ testCommand: 'go test ./...', instructionFiles: ['AGENTS.md'] });
  });

  it('fails provider_not_configured when keys are withheld or absent', async () => {
    for (const opts of [{ bundleFails: true }, { vars: {} }]) {
      const ctx = setup(opts);
      await mention(ctx);
      expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'provider_not_configured' });
      expect(ctx.docks.create).not.toHaveBeenCalled();
    }
  });

  it('fails agent_unsupported for agents without a runner', async () => {
    const ctx = setup({ mapping: { agent: 'claude-code' } });
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'agent_unsupported' });
  });

  it('runs codex mappings with codex exec, and fails provider_not_configured on an Anthropic-only org', async () => {
    const ctx = setup({ mapping: { agent: 'codex' }, vars: { OPENAI_API_KEY: 'sk-oa' } });
    await mention(ctx);
    expect(ctx.runs.get('run-1')).toMatchObject({ agent: 'codex', model: 'openai/gpt-5' });
    expect(ctx.launched().runner).toContain('"$AGENT" exec');
    expect(ctx.fastRuns.create.mock.calls.length + ctx.docks.create.mock.calls.length).toBe(1);
    const anthropic = setup({ mapping: { agent: 'codex' } });
    await mention(anthropic);
    expect(anthropic.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'provider_not_configured' });
  });
});

const FIX = {
  status: 'fixed',
  summary: 'Guard null widget',
  testOk: true,
  parentSha: 'a'.repeat(40),
  commitMessage: 'Fix #42: guard null widget',
  changes: [
    { path: 'src/widget.ts', mode: '100644' as const, content: Buffer.from('fixed').toString('base64') },
    { path: 'old.txt', deleted: true },
  ],
};

async function complete(ctx: ReturnType<typeof setup>, input: Record<string, unknown>, auth = `Bearer ${COMPLETION_PLAIN}`) {
  const out = await ctx.service.completeRun('run-1', auth, input as never);
  await ctx.service.settled();
  return { out, run: ctx.runs.get('run-1')! };
}

describe('completion callback', () => {
  it('commits the change set on the base, opens a ready PR, then publishes artifacts and stops the dock', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ baseSha: 'a'.repeat(40) }));
    ctx.api.getBranchHead.mockRejectedValue(new Error('404'));
    const { out, run } = await complete(ctx, FIX);
    expect(out).toMatchObject({ completionConsumed: true, completionStatus: 'fixed' });
    expect(run).toMatchObject({ state: 'done', prNumber: 9, artifactStatus: 'published' });
    expect(ctx.api.getCommitTree).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghs_secret_token', sha: 'a'.repeat(40) }));
    expect(ctx.api.createTree).toHaveBeenCalledWith(expect.objectContaining({
      baseTree: 'tree-base',
      entries: [
        { path: 'src/widget.ts', mode: '100644', type: 'blob', sha: `blob-${Buffer.from('fixed').toString('base64')}` },
        { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
      ],
    }));
    expect(ctx.api.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'Fix #42: guard null widget', tree: 'tree-new', parents: ['a'.repeat(40)] }));
    expect(ctx.api.setBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'dock/run-run-1', sha: 'commit-new', create: true }));
    const pr = ctx.api.createPullRequest.mock.calls[0][0];
    expect(pr).toMatchObject({ head: 'dock/run-run-1', base: 'main', title: '[dock] Fix #42: guard null widget', draft: false });
    expect(pr.body).toContain('harness: test command passed (`bun test`)');
    expect(ctx.comments()).toContain('Fix ready for review: https://github.com/acme/web/pull/9');
    expect(ctx.fastRuns.collectArtifacts).toHaveBeenCalledWith({ hostId: 'host-7', runtimeId: 'dock-1' }, expect.arrayContaining(['/run/dock-fast/RESULT.json']), 'run:run-1:artifacts:1');
    expect(ctx.docks.stop).toHaveBeenCalledWith('user-1', 'dock-1', {});
  });

  it('fast-forwards an existing run branch when the guest started from its head', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun());
    ctx.api.getBranchHead.mockResolvedValue({ sha: 'a'.repeat(40) });
    await complete(ctx, FIX);
    expect(ctx.api.setBranch).toHaveBeenCalledWith(expect.objectContaining({ create: false, sha: 'commit-new' }));
  });

  it('fails push_failed without committing when the branch moved under the guest', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun());
    ctx.api.getBranchHead.mockResolvedValue({ sha: 'b'.repeat(40) });
    const { run } = await complete(ctx, FIX);
    expect(run).toMatchObject({ state: 'failed', failureReason: 'push_failed' });
    expect(ctx.api.createCommit).not.toHaveBeenCalled();
  });

  it('opens a draft when the harness tests failed', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ baseSha: 'a'.repeat(40) }));
    ctx.api.getBranchHead.mockRejectedValue(new Error('404'));
    await complete(ctx, { ...FIX, testOk: false });
    expect(ctx.api.createPullRequest.mock.calls[0][0]).toMatchObject({ draft: true });
    expect(ctx.comments()[0]).toContain('Draft fix opened');
  });

  it('fails empty_fix without GitHub writes when nothing changed', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun());
    const { run } = await complete(ctx, { status: 'fixed', testOk: true, parentSha: 'a'.repeat(40), changes: [] });
    expect(run).toMatchObject({ state: 'failed', failureReason: 'empty_fix' });
    expect(ctx.api.createBlob).not.toHaveBeenCalled();
    expect(ctx.api.createPullRequest).not.toHaveBeenCalled();
  });

  it.each(['../escape', '/etc/passwd', '.git/config', 'a//b', 'x/./y'])('refuses change path %s', async (path) => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ baseSha: 'a'.repeat(40) }));
    const { run } = await complete(ctx, { ...FIX, changes: [{ path, mode: '100644', content: '' }] });
    expect(run).toMatchObject({ state: 'failed', failureReason: 'unsupported_change' });
    expect(ctx.api.createBlob).not.toHaveBeenCalled();
  });

  it('fails pr_create_failed when GitHub rejects the PR', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ baseSha: 'a'.repeat(40) }));
    ctx.api.getBranchHead.mockRejectedValue(new Error('404'));
    ctx.api.createPullRequest.mockRejectedValue(new Error('github api failed with status 422'));
    const { run } = await complete(ctx, FIX);
    expect(run).toMatchObject({ state: 'failed', failureReason: 'pr_create_failed' });
  });

  it('finishes no_change without any PR', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun());
    const { run } = await complete(ctx, { status: 'no_change', summary: 'works as intended' });
    expect(run).toMatchObject({ state: 'done', completionStatus: 'no_change' });
    expect(ctx.api.createPullRequest).not.toHaveBeenCalled();
    expect(ctx.comments()[0]).toContain('no change: works as intended');
  });

  it.each(['clone_failed', 'agent_failed', 'agent_no_result', 'agent_timeout', 'empty_fix', 'diff_too_large'])('keeps runner failure reason %s', async (reason) => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun());
    const { run } = await complete(ctx, { status: 'failed', reason });
    expect(run).toMatchObject({ state: 'failed', failureReason: reason });
    expect(ctx.comments()[0]).toContain(reason);
  });

  it('maps agent free-text reasons to failed', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun());
    const { run } = await complete(ctx, { status: 'failed', reason: 'could not repro', summary: 'flaky' });
    expect(run).toMatchObject({ failureReason: 'failed' });
  });

  it('claims once: wrong tokens 401, identical redelivery replays, a different replay 401s, and no double commit', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ baseSha: 'a'.repeat(40) }));
    ctx.api.getBranchHead.mockRejectedValue(new Error('404'));
    expect((await catchErr(ctx.service.completeRun('run-1', 'Bearer nope', { status: 'fixed' }))).status).toBe(401);
    expect((await catchErr(ctx.service.completeRun('run-1', undefined, { status: 'fixed' }))).status).toBe(401);
    const first = ctx.service.completeRun('run-1', `Bearer ${COMPLETION_PLAIN}`, FIX as never);
    const retry = ctx.service.completeRun('run-1', `Bearer ${COMPLETION_PLAIN}`, FIX as never);
    await Promise.all([first, retry]);
    await ctx.service.settled();
    expect(ctx.api.createCommit).toHaveBeenCalledTimes(1);
    expect((await catchErr(ctx.service.completeRun('run-1', `Bearer ${COMPLETION_PLAIN}`, { status: 'no_change' }))).status).toBe(401);
  });
});

describe('timeout sweep', () => {
  it('fails runs silent past the timeout as completion_lost and releases their runtime', async () => {
    const ctx = setup({ timeoutMs: 60000 });
    ctx.runs.set('run-1', liveRun({ executionTarget: 'fast', dockId: null, runtimeId: 'run-1', runtimeHostId: 'host-3', updatedAt: new Date(NOW - 120000) }));
    await expect(ctx.service.sweepTimeouts()).resolves.toEqual({ swept: 1 });
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'failed', failureReason: 'completion_lost' });
    expect(ctx.fastRuns.terminate).toHaveBeenCalledWith({ hostId: 'host-3', runtimeId: 'run-1' }, 'run:run-1:terminate');
    expect(ctx.metering.closeWindowsForRuntime).toHaveBeenCalledWith('run-1');
    expect(ctx.comments()[0]).toContain('completion_lost');
  });

  it('is scheduled on module init and stops on destroy', async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup();
      const sweep = vi.spyOn(ctx.service, 'sweepTimeouts').mockResolvedValue({ swept: 0 });
      ctx.service.onModuleInit();
      vi.advanceTimersByTime(60000);
      expect(sweep).toHaveBeenCalledTimes(1);
      await ctx.service.onModuleDestroy();
      vi.advanceTimersByTime(120000);
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('promotion', () => {
  it('moves a live Fast Run onto an agent dock that resumes the run branch with a fresh token', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ executionTarget: 'fast', dockId: null, runtimeId: 'run-1', runtimeHostId: 'host-3', completionTokenHash: 'old-hash' }));
    const user = { id: 'user-1', email: 'u@x.co', emailVerified: true, isInteractive: true };
    const out = await ctx.service.promoteRun(user as never, 'run-1');
    await ctx.service.settled();
    expect(out).toMatchObject({ executionTarget: 'dock' });
    expect(out).not.toHaveProperty('completionTokenHash');
    expect(ctx.runs.get('run-1')).toMatchObject({ attemptNumber: 2 });
    expect(ctx.fastRuns.terminate).toHaveBeenCalledWith({ hostId: 'host-3', runtimeId: 'run-1' }, 'run:run-1:terminate');
    expect(ctx.docks.create.mock.calls[0][2]).toBe('run:run-1:provision:2');
    const { ref, prepare, launchToken, launchEnv } = ctx.launched();
    expect(ref).toEqual({ hostId: 'host-7', runtimeId: 'dock-1' });
    expect(launchToken).toBe('run:run-1:launch:2');
    expect(launchEnv).toEqual({ GITHUB_COMPLETION_TOKEN: COMPLETION_PLAIN, DOCK_LLM_TOKEN: GATEWAY_PLAIN });
    expect(prepare).toContain("ls-remote --exit-code origin 'refs/heads/dock/run-run-1'");
    expect(ctx.runs.get('run-1')).toMatchObject({ state: 'working', completionTokenHash: hashToken(COMPLETION_PLAIN), dockId: 'dock-1' });
  });

  it('refuses terminal runs', async () => {
    const ctx = setup();
    ctx.runs.set('run-1', liveRun({ executionTarget: 'fast', state: 'failed' }));
    const user = { id: 'user-1', email: 'u@x.co', emailVerified: true, isInteractive: true };
    expect((await catchErr(ctx.service.promoteRun(user as never, 'run-1'))).status).toBe(409);
  });
});
