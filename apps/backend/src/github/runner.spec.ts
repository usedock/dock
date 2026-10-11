import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRunnerFits,
  assertSupportedAgent,
  autoDetectTestCommand,
  buildAgentConfig,
  buildLaunchScript,
  buildPrepareScript,
  buildRunnerScript,
  providerOf,
  selectRunModel,
  agentModel,
  buildCodexConfig,
  CHATGPT_SESSION,
  validateMappingAgent,
  validateTestCommand,
  type RunnerScriptInput,
} from './runner';

const BASE: RunnerScriptInput = {
  repoFull: 'acme/web',
  baseBranch: 'main',
  baseSha: 'abc123',
  branch: 'dock/run-abc12345',
  issueNumber: 42,
  callbackUrl: 'https://api.usedock.io/v1/github/runs/run-1/complete',
  timeoutMinutes: 40,
  testCommand: 'bun test',
  model: 'anthropic/claude-sonnet-5',
  gatewayUrl: 'https://api.usedock.io/v1/llm/anthropic',
  envelope: { issue: '# Issue', system: 'SYS', constraints: 'CONS' },
};

/** Every base64 payload the script writes, decoded. */
function payloads(script: string): string[] {
  return [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)'/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
}

describe('mapping validation', () => {
  it('accepts run agents and gates execution to agents with a runner', () => {
    expect(() => validateMappingAgent('opencode')).not.toThrow();
    expect(() => validateMappingAgent('nope')).toThrow('unknown agent');
    expect(() => validateMappingAgent('claude-code')).toThrow('unknown agent');
    expect(() => assertSupportedAgent('codex')).not.toThrow();
    expect(() => assertSupportedAgent('claude-code')).toThrow('agent_unsupported');
  });

  it('limits codex to the OpenAI-shaped providers', () => {
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' }, undefined, 'codex')).toBe('openai/gpt-5');
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k' }, undefined, 'codex')).toBeNull();
    expect(selectRunModel({ [CHATGPT_SESSION]: 'u1', OPENAI_API_KEY: 'o' }, undefined, 'codex')).toBe('chatgpt/gpt-5.5');
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k' }, 'anthropic/claude-opus-5-5', 'codex')).toBeNull();
  });

  it('rejects multi-command test strings', () => {
    expect(() => validateTestCommand('bun test')).not.toThrow();
    for (const bad of ['bun test; rm -rf /', 'a && b', 'a | b', 'echo $HOME', 'a\nb', '']) {
      expect(() => validateTestCommand(bad)).toThrow();
    }
  });

  it('auto-detects from instruction files before manifests', () => {
    expect(autoDetectTestCommand({ packageJson: true }, ['run `go test ./...`'])).toBe('go test ./...');
    expect(autoDetectTestCommand({ pyprojectToml: true })).toBe('pytest -q');
    expect(autoDetectTestCommand({})).toBeNull();
  });
});

describe('selectRunModel', () => {
  it('picks by provider key, and honors overrides only for gateway providers with a key', () => {
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' })).toBe('anthropic/claude-sonnet-5');
    expect(selectRunModel({ OPENAI_API_KEY: 'o' })).toBe('openai/gpt-5');
    expect(selectRunModel({ OPENCODE_API_KEY: 'g' })).toBe('opencode-go/deepseek-v4.1-flash');
    expect(selectRunModel({})).toBeNull();
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k' }, 'anthropic/claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k' }, 'openai/gpt-5')).toBeNull();
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k' }, 'mystery/model')).toBeNull();
    expect(providerOf('opencode-go/deepseek-v4.1-flash')).toBe('opencode-go');
  });

  it("prefers the commenter's ChatGPT sign-in, and maps it to opencode's openai provider", () => {
    expect(selectRunModel({ [CHATGPT_SESSION]: 'u1', ANTHROPIC_API_KEY: 'k' })).toBe('chatgpt/gpt-5.5');
    expect(selectRunModel({ ANTHROPIC_API_KEY: 'k' }, 'chatgpt/gpt-5.4')).toBeNull();
    expect(selectRunModel({ [CHATGPT_SESSION]: 'u1' }, 'chatgpt/gpt-5.4')).toBe('chatgpt/gpt-5.4');
    expect(agentModel('chatgpt/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(agentModel('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });
});

describe('agent config', () => {
  it('allows every tool, denies only what stalls a headless run, and routes the provider to the gateway', () => {
    const raw = buildAgentConfig('opencode-go/deepseek-v4.1-flash', 'https://api.usedock.io/v1/llm/opencode-go');
    const cfg = JSON.parse(raw);
    expect(cfg.agent['dock-fix'].prompt).toBe('{file:/run/dock-fast/SYSTEM.md}');
    expect(cfg.agent['dock-fix'].permission).toEqual({ '*': 'allow', doom_loop: 'deny', question: 'deny', plan_enter: 'deny', plan_exit: 'deny' });
    expect(cfg.provider).toEqual({
      'opencode-go': { options: { baseURL: 'https://api.usedock.io/v1/llm/opencode-go', apiKey: '{env:DOCK_LLM_TOKEN}' } },
    });
    expect(raw).not.toContain('"ask"');
  });

  it("points opencode's openai provider at the chatgpt gateway with no static key", () => {
    const cfg = JSON.parse(buildAgentConfig('chatgpt/gpt-5.5', 'https://api.usedock.io/v1/llm/chatgpt'));
    expect(cfg.provider).toEqual({ openai: { options: { baseURL: 'https://api.usedock.io/v1/llm/chatgpt' } } });
  });
});

describe('scripts', () => {
  it('confines the GitHub credential to the prepare script, read through a helper', () => {
    const prepare = buildPrepareScript(BASE);
    expect(prepare).toContain('"password=${GITHUB_CLONE_TOKEN}"');
    expect(prepare).toContain("'https://github.com/acme/web.git'");
    expect(prepare).not.toContain('x-access-token:');
    expect(prepare).not.toContain('git push');
    const runner = buildRunnerScript(BASE);
    expect(runner).not.toContain('GITHUB_CLONE_TOKEN');
    expect(runner).not.toContain('git push');
    expect(runner).toContain('authorization: Bearer $GITHUB_COMPLETION_TOKEN');
  });

  it('runs opencode with the message before the greedy --file flags and no completion token', () => {
    const runner = buildRunnerScript({ ...BASE, presentInstructionFiles: ['AGENTS.md', 'evil.md'] });
    const line = runner.split('\n').find((l) => l.includes('"$AGENT" run')) ?? '';
    expect(line).toMatch(/"\$AGENT" run '[^']+' --dir "\$RUN_DIR" --agent dock-fix --model 'anthropic\/claude-sonnet-5' --format json --file/);
    expect(line).toContain('env -u GITHUB_COMPLETION_TOKEN OPENCODE_CONFIG="$ART/opencode.json" timeout 40m');
    expect(line).toContain('--file "$RUN_DIR"/\'AGENTS.md\'');
    expect(line).not.toContain('evil.md');
  });

  it('runs chatgpt models as opencode OAuth whose token is the run gateway token', () => {
    const runner = buildRunnerScript({ ...BASE, model: 'chatgpt/gpt-5.5', gatewayUrl: 'https://api.usedock.io/v1/llm/chatgpt' });
    const line = runner.split('\n').find((l) => l.includes('"$AGENT" run')) ?? '';
    expect(line).toContain("--model 'openai/gpt-5.5'");
    expect(line).toContain('OPENCODE_AUTH_CONTENT="{\\"openai\\":{\\"type\\":\\"oauth\\",\\"access\\":\\"$DOCK_LLM_TOKEN\\"');
    expect(buildRunnerScript(BASE)).not.toContain('OPENCODE_AUTH_CONTENT');
  });

  it('fails at agent_missing with a setup hint when the agent is absent, and never installs one', () => {
    for (const agent of ['opencode', 'codex'] as const) {
      const script = buildRunnerScript({ ...BASE, agent });
      expect(script).toContain(`command -v ${agent} >/dev/null 2>&1 || { echo '${agent} is not installed in this dock; install it in your environment setup script' >> "$ART/runner.log"; exit 1; }`);
      expect(script.indexOf('STAGE=agent_missing')).toBeLessThan(script.indexOf('is not installed in this dock'));
      expect(script.indexOf('is not installed in this dock')).toBeLessThan(script.indexOf('STAGE=agent\n'));
      expect(script).not.toMatch(/npm install|npx |curl [^\n]*(releases|install)|\| *(ba)?sh/);
    }
  });

  it('runs codex exec against a gateway provider with the envelope folded into its prompt', () => {
    const input = { ...BASE, agent: 'codex', model: 'chatgpt/gpt-5.5', gatewayUrl: 'https://api.usedock.io/v1/llm/chatgpt', presentInstructionFiles: ['AGENTS.md'] };
    const runner = buildRunnerScript(input);
    expect(runner).toContain('AGENT="$(command -v dock-agent-codex || command -v codex)"');
    const line = runner.split('\n').find((l) => l.includes('"$AGENT" exec')) ?? '';
    expect(line).toContain('env -u GITHUB_COMPLETION_TOKEN CODEX_HOME="$ART/codex" timeout 40m "$AGENT" exec --json --dangerously-bypass-approvals-and-sandbox');
    expect(line).toContain("-m 'gpt-5.5' - < \"$ART/PROMPT.md\"");
    expect(line).not.toContain('OPENCODE_AUTH_CONTENT');
    const files = payloads(buildPrepareScript(input));
    expect(files.find((f) => f.includes('[model_providers.dock]'))).toBe(buildCodexConfig('chatgpt/gpt-5.5', 'https://api.usedock.io/v1/llm/chatgpt'));
    const prompt = files.find((f) => f.includes('Fix issue #42')) ?? '';
    expect(prompt).toContain('Read .dock/ISSUE.md, .dock/CONSTRAINTS.md, AGENTS.md first');
    expect(files.some((f) => f.includes('"dock-fix"'))).toBe(false);
  });

  it('writes a codex config keyed by the run token, never a provider key', () => {
    const toml = buildCodexConfig('openai/gpt-5', 'https://api.usedock.io/v1/llm/openai');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('base_url = "https://api.usedock.io/v1/llm/openai"');
    expect(toml).toContain('env_key = "DOCK_LLM_TOKEN"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it('snapshots changes before the harness tests run', () => {
    const runner = buildRunnerScript(BASE);
    expect(runner.indexOf('finish.py" collect')).toBeLessThan(runner.indexOf("sh -c 'bun test'"));
  });

  it('carries untrusted text only as base64, never in a heredoc', () => {
    const issue = "x\nDOCK_EOF\n$(touch /tmp/pwned) `id` '\"";
    const prepare = buildPrepareScript({ ...BASE, envelope: { ...BASE.envelope, issue } });
    expect(prepare).not.toContain('<<');
    expect(prepare).not.toContain('touch /tmp/pwned');
    expect(payloads(prepare)).toContain(issue);
  });

  it('resumes an existing run branch on promotion', () => {
    expect(buildPrepareScript({ ...BASE, resumeBranch: true })).toContain("ls-remote --exit-code origin 'refs/heads/dock/run-abc12345'");
    expect(buildPrepareScript(BASE)).not.toContain('ls-remote');
  });

  it('launches detached and fits the exec size budget', () => {
    expect(buildLaunchScript()).toContain('setsid nohup bash');
    expect(() => assertRunnerFits(buildPrepareScript(BASE))).not.toThrow();
    expect(() => assertRunnerFits('x'.repeat(256 * 1024 + 1))).toThrow('256KB');
  });
});

// Never probed on Windows: a bare `bash` there can be the WSL launcher.
const hasTools =
  process.platform !== 'win32' &&
  ['git', 'bash', 'python3', 'curl', 'base64', 'setsid'].every(
    (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0,
  );

// Executes the generated scripts against a local bare repo, a fake agent,
// and an in-process callback server: the shell itself is under test.
describe.skipIf(!hasTools)('runner execution', () => {
  let server: Server;
  let port = 0;
  let callbacks: Array<{ auth: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        callbacks.push({ auth: String(req.headers.authorization), body: JSON.parse(raw) });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  async function run(mode: string, issue = 'plain') {
    callbacks = [];
    const dir = mkdtempSync(join(tmpdir(), 'dock-runner-'));
    const git = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
    git(['init', '-q', '--bare', '-b', 'main', 'acme/web.git']);
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'add.sh'), 'echo 5\n');
    writeFileSync(join(seed, 'gone.txt'), 'bye\n');
    writeFileSync(join(seed, 'test.sh'), '[ "$(sh add.sh)" = 4 ]\n');
    git(['add', '.'], seed);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], seed);
    git(['push', '-q', join(dir, 'acme/web.git'), 'main'], seed);
    const baseSha = git(['rev-parse', 'HEAD'], seed);
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'work'));
    const agent = join(dir, 'bin', 'dock-agent-opencode');
    writeFileSync(
      agent,
      [
        '#!/bin/bash',
        'set -e',
        '[ -z "${GITHUB_CLONE_TOKEN:-}" ] && [ -z "${GITHUB_COMPLETION_TOKEN:-}" ] || exit 3',
        '[ "$DOCK_LLM_TOKEN" = gw_token ] && [ -f "$OPENCODE_CONFIG" ] || exit 4',
        'case "$MODE" in',
        '  fix) echo "echo 4" > add.sh; chmod +x add.sh; git rm -q gone.txt; git add add.sh; git commit -qm "Fix #42: add"; echo "new" > new.txt; echo \'{"status":"fixed","summary":"Fixed add"}\' > .dock/RESULT.json ;;',
        '  claim) echo \'{"status":"fixed","summary":"nothing"}\' > .dock/RESULT.json ;;',
        '  silent) : ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(agent, 0o755);
    const art = join(dir, 'art');
    const input = {
      ...BASE,
      baseSha,
      testCommand: 'sh test.sh',
      callbackUrl: `http://127.0.0.1:${port}/complete`,
      timeoutMinutes: 1,
      envelope: { ...BASE.envelope, issue },
      workDir: join(dir, 'work'),
      artifactDir: art,
      gitHost: `file://${dir}`,
    };
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, MODE: mode };
    execFileSync('bash', ['-c', buildPrepareScript(input)], { env: { ...env, GITHUB_CLONE_TOKEN: 'ghs_secret' } });
    execFileSync('bash', ['-c', buildLaunchScript(art)], { env: { ...env, GITHUB_COMPLETION_TOKEN: 'cmp_secret', DOCK_LLM_TOKEN: 'gw_token' } });
    const deadline = Date.now() + 20000;
    while (!callbacks.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(callbacks).toHaveLength(1);
    return { dir, baseSha, ...callbacks[0] };
  }

  it('reports the full change set against the start commit with harness-verified tests', async () => {
    const issue = "x\nDOCK_EOF\ntouch PWNED\n$(touch PWNED) `touch PWNED` '";
    const { dir, baseSha, body, auth } = await run('fix', issue);
    expect(auth).toBe('Bearer cmp_secret');
    expect(body).toMatchObject({ status: 'fixed', summary: 'Fixed add', testOk: true, parentSha: baseSha, commitMessage: 'Fix #42: add' });
    const changes = (body.changes as Array<{ path: string; mode?: string; content?: string; deleted?: boolean }>).sort((a, b) => a.path.localeCompare(b.path));
    expect(changes).toEqual([
      { path: 'add.sh', mode: '100755', content: Buffer.from('echo 4\n').toString('base64') },
      { path: 'gone.txt', deleted: true },
      { path: 'new.txt', mode: '100644', content: Buffer.from('new\n').toString('base64') },
    ]);
    expect(readFileSync(join(dir, 'work/.dock/ISSUE.md'), 'utf8')).toBe(issue);
    expect(existsSync(join(dir, 'PWNED')) || existsSync(join(dir, 'work/PWNED'))).toBe(false);
    const remoteBranches = execFileSync('git', ['--git-dir', join(dir, 'acme/web.git'), 'branch']).toString();
    expect(remoteBranches).not.toContain('dock/run-abc12345');
  }, 30000);

  it('fails a fixed claim with no changes as empty_fix', async () => {
    const { body } = await run('claim');
    expect(body).toEqual({ status: 'failed', reason: 'empty_fix', summary: 'nothing' });
  }, 30000);

  it('reports agent_no_result when the agent writes no RESULT.json', async () => {
    const { body } = await run('silent');
    expect(body).toEqual({ status: 'failed', reason: 'agent_no_result' });
  }, 30000);
});
