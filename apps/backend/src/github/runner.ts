import { runAgentNames } from './run-agents';
import { REPO_INSTRUCTION_FILES, RUNNER_SCRIPT_MAX_BYTES } from './agent-prompt';

/** Longest accepted explicit test command; longer is a write-time rejection. */
export const MAX_TEST_COMMAND_CHARS = 500;

/** Guest paths shared by Fast Runs and agent-enabled docks; the exec agent may read both roots. */
export const DOCK_USER_HOME = '/home/user';
export const RUN_WORK_DIR = `${DOCK_USER_HOME}/work`;
export const RUN_ARTIFACT_DIR = '/run/dock-fast';

/** Files the backend collects as run evidence before the runtime goes away. */
export const RUN_ARTIFACT_FILES = ['RESULT.json', 'events.ndjson', 'opencode.log', 'codex.log', 'test.log', 'runner.log'] as const;

/** Sentinel provider env entry meaning the commenter's own ChatGPT sign-in serves the run. */
export const CHATGPT_SESSION = 'DOCK_CHATGPT_SESSION';

/** Model used when GITHUB_RUN_MODEL is unset, keyed by the provider key the run carries. */
export const DEFAULT_RUN_MODELS = [
  { key: CHATGPT_SESSION, model: 'chatgpt/gpt-5.5' },
  { key: 'ANTHROPIC_API_KEY', model: 'anthropic/claude-sonnet-5' },
  { key: 'OPENAI_API_KEY', model: 'openai/gpt-5' },
  { key: 'OPENCODE_API_KEY', model: 'opencode-go/deepseek-v4.1-flash' },
] as const;

/** Providers the LLM gateway fronts: upstream base, bundle key, and how the key is presented. */
export const LLM_UPSTREAMS: Record<string, { base: string; key: string; auth: 'x-api-key' | 'bearer' }> = {
  anthropic: { base: 'https://api.anthropic.com/v1', key: 'ANTHROPIC_API_KEY', auth: 'x-api-key' },
  openai: { base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', auth: 'bearer' },
  opencode: { base: 'https://opencode.ai/zen/v1', key: 'OPENCODE_API_KEY', auth: 'bearer' },
  'opencode-go': { base: 'https://opencode.ai/zen/go/v1', key: 'OPENCODE_API_KEY', auth: 'bearer' },
  // Codex backend; the gateway attaches the user's ChatGPT access token instead of a bundle key.
  chatgpt: { base: 'https://chatgpt.com/backend-api/codex', key: CHATGPT_SESSION, auth: 'bearer' },
};

/** Agents a run can execute, and the gateway providers each can drive; codex speaks only OpenAI Responses. */
export const RUN_AGENT_PROVIDERS: Record<string, readonly string[]> = {
  opencode: Object.keys(LLM_UPSTREAMS),
  codex: ['chatgpt', 'openai'],
};

const KNOWN_TEST_COMMANDS = ['bun test', 'npm test --', 'pytest -q', 'go test ./...', 'cargo test'] as const;

/** Mapping-write validation: must be a known run agent. */
export function validateMappingAgent(agent: string): void {
  if (!runAgentNames().includes(agent)) throw new Error(`unknown agent: ${agent}`);
}

/** Run-time gate: anything without a runner fails before spend. */
export function assertSupportedAgent(agent: string): void {
  if (!RUN_AGENT_PROVIDERS[agent]) throw new Error(`agent_unsupported: ${agent}`);
}

function validationError(message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  (err as { code?: string }).code = 'validation_error';
  return err;
}

/** Single command line only; metacharacter smuggling is a write-time rejection. */
export function validateTestCommand(cmd: string): void {
  if (!cmd.trim()) throw validationError('testCommand must not be empty');
  if (cmd.length > MAX_TEST_COMMAND_CHARS) throw validationError('testCommand must be at most 500 characters');
  if (/[\n\r\0]/.test(cmd)) throw validationError('testCommand must be a single line');
  if (/[;&|`$><]/.test(cmd)) throw validationError('testCommand must be a single command without shell metacharacters');
}

export interface ManifestPresence {
  packageJson?: boolean;
  bunLock?: boolean;
  requirementsTxt?: boolean;
  pyprojectToml?: boolean;
  goMod?: boolean;
  cargoToml?: boolean;
}

/** Auto-detect preferring commands named in repo instruction files, else manifest order. */
export function autoDetectTestCommand(manifests: ManifestPresence, instructionTexts: string[] = []): string | null {
  const haystack = instructionTexts.join('\n');
  for (const known of KNOWN_TEST_COMMANDS) {
    if (haystack.includes(known)) return known;
  }
  if (manifests.packageJson || manifests.bunLock) return 'bun test';
  if (manifests.requirementsTxt || manifests.pyprojectToml) return 'pytest -q';
  if (manifests.goMod) return 'go test ./...';
  if (manifests.cargoToml) return 'cargo test';
  return null;
}

/** Explicit override wins; otherwise the first provider key present picks the model. Only providers the agent can drive qualify. */
export function selectRunModel(env: Record<string, string>, override?: string, agent = 'opencode'): string | null {
  const drives = RUN_AGENT_PROVIDERS[agent] ?? [];
  if (override) {
    const upstream = LLM_UPSTREAMS[providerOf(override)];
    return upstream && drives.includes(providerOf(override)) && env[upstream.key] ? override : null;
  }
  return DEFAULT_RUN_MODELS.find((m) => env[m.key] && drives.includes(providerOf(m.model)))?.model ?? null;
}

/** `provider/model` prefix. */
export function providerOf(model: string): string {
  return model.split('/')[0] ?? '';
}

/** opencode only speaks ChatGPT subscriptions through its built-in `openai` provider. */
export function agentModel(model: string): string {
  return providerOf(model) === 'chatgpt' ? `openai/${model.slice('chatgpt/'.length)}` : model;
}

/**
 * opencode auth for `chatgpt/*` runs: an OAuth entry whose access token is
 * the run's gateway token, so opencode sends Codex-shaped requests (system
 * prompt as `instructions`, no output cap) to the gateway's base URL. A
 * gateway path never contains `/v1/responses`, which keeps opencode from
 * rewriting it to chatgpt.com; the far expiry means it never refreshes.
 */
function chatgptAuthEnv(): string {
  return `OPENCODE_AUTH_CONTENT="{\\"openai\\":{\\"type\\":\\"oauth\\",\\"access\\":\\"$DOCK_LLM_TOKEN\\",\\"refresh\\":\\"dock-gateway\\",\\"expires\\":4102444800000}}"`;
}

/** Bare model id for agents that take no provider prefix. */
function modelId(model: string): string {
  return model.slice(providerOf(model).length + 1);
}

/** Codex config for runs: one custom Responses provider at the gateway, keyed by the run token. */
export function buildCodexConfig(model: string, gatewayUrl: string): string {
  return [
    `model = ${JSON.stringify(modelId(model))}`,
    'model_provider = "dock"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.dock]',
    'name = "Dock gateway"',
    `base_url = ${JSON.stringify(gatewayUrl)}`,
    'env_key = "DOCK_LLM_TOKEN"',
    'wire_api = "responses"',
    '',
  ].join('\n');
}

/**
 * opencode config for the dock-fix agent, loaded via OPENCODE_CONFIG. The
 * dock is the sandbox, so every tool is allowed; only rules that would stall
 * a headless run are denied. The model provider points at the control-plane
 * gateway with a run-scoped token, so no provider key enters the guest.
 */
export function buildAgentConfig(model: string, gatewayUrl: string, artifactDir: string = RUN_ARTIFACT_DIR): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider:
      providerOf(model) === 'chatgpt'
        ? { openai: { options: { baseURL: gatewayUrl } } }
        : { [providerOf(model)]: { options: { baseURL: gatewayUrl, apiKey: '{env:DOCK_LLM_TOKEN}' } } },
    agent: {
      'dock-fix': {
        mode: 'primary',
        description: 'Dock issue fixer',
        prompt: `{file:${artifactDir}/SYSTEM.md}`,
        permission: { '*': 'allow', doom_loop: 'deny', question: 'deny', plan_enter: 'deny', plan_exit: 'deny' },
      },
    },
  });
}

/** Ceilings for the change set a run may hand back; larger fixes fail as diff_too_large. */
export const MAX_CHANGE_FILES = 1000;
export const MAX_CHANGE_BYTES = 8 * 1024 * 1024;

/**
 * Static helper. `collect` snapshots the agent's changes against the start
 * commit before the harness tests run; `emit` turns runner state into the
 * completion body, which carries the change set instead of a push.
 */
const FINISH_PY = `import base64, json, os, subprocess, sys
mode, art, dock, run_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
MAX_FILES, MAX_BYTES = ${MAX_CHANGE_FILES}, ${MAX_CHANGE_BYTES}
def read(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''
def code(name):
    raw = read(os.path.join(art, name))
    return int(raw) if raw.lstrip('-').isdigit() else None
def git(*args):
    return subprocess.run(['git', '-C', run_dir, *args], check=True, capture_output=True).stdout
def result():
    try:
        value = json.loads(read(os.path.join(dock, 'RESULT.json')) or 'null')
    except ValueError:
        return None
    return value if isinstance(value, dict) and value.get('status') in ('fixed', 'no_change', 'failed') else None
def collect():
    start = read(os.path.join(art, 'start.sha'))
    git('add', '-A')
    parts = git('diff', '--cached', '--name-status', '--no-renames', '-z', start).split(b'\\0')
    changes, total = [], 0
    for status, path in zip(parts[0::2], parts[1::2]):
        name = path.decode('utf-8', 'surrogateescape')
        if status == b'D':
            changes.append({'path': name, 'deleted': True})
            continue
        entry = git('ls-files', '-s', '-z', '--', path).split(b' ')[0].decode()
        if entry not in ('100644', '100755', '120000'):
            return {'error': 'unsupported_change'}
        full = os.path.join(run_dir, name)
        raw = os.readlink(full).encode() if entry == '120000' else open(full, 'rb').read()
        total += len(raw)
        changes.append({'path': name, 'mode': entry, 'content': base64.b64encode(raw).decode()})
    if len(changes) > MAX_FILES or total > MAX_BYTES:
        return {'error': 'diff_too_large'}
    subjects = git('log', '--reverse', '--format=%s', start + '..HEAD').decode().splitlines()
    return {'parentSha': start, 'commitMessage': subjects[0] if subjects else '', 'changes': changes}
def emit(stage, issue):
    def out(body):
        for key, limit in (('summary', 2000), ('reason', 200), ('commitMessage', 500)):
            if isinstance(body.get(key), str):
                body[key] = body[key][:limit]
        print(json.dumps(body))
        sys.exit(0)
    stage_reasons = {'agent_missing': 'agent_unsupported', 'agent': 'agent_failed', 'collect': 'runner_failed'}
    if stage != 'done':
        out({'status': 'failed', 'reason': stage_reasons.get(stage, 'runner_failed')})
    agent_exit = code('agent.exit')
    res = result()
    if res is None:
        out({'status': 'failed', 'reason': 'agent_timeout' if agent_exit == 124 else 'agent_failed' if agent_exit else 'agent_no_result'})
    summary = res.get('summary') if isinstance(res.get('summary'), str) else None
    extra = {'summary': summary} if summary else {}
    if res['status'] != 'fixed':
        reason = {'reason': res['reason']} if isinstance(res.get('reason'), str) else {}
        out({'status': res['status'], **extra, **reason})
    changes = json.loads(read(os.path.join(art, 'changes.json')) or '{}')
    if changes.get('error'):
        out({'status': 'failed', 'reason': changes['error'], **extra})
    if not changes.get('changes'):
        out({'status': 'failed', 'reason': 'empty_fix', **extra})
    message = changes['commitMessage'] or 'Fix #%s: %s' % (issue, (summary or 'agent fix').splitlines()[0])
    out({'status': 'fixed', **extra, 'testOk': code('test.exit') == 0, 'parentSha': changes['parentSha'], 'commitMessage': message, 'changes': changes['changes']})
if mode == 'collect':
    res = result()
    if res is not None and res['status'] == 'fixed':
        try:
            print(json.dumps(collect()))
        except Exception:
            print(json.dumps({'error': 'runner_failed'}))
else:
    emit(sys.argv[5], sys.argv[6])
`;

export interface RunnerScriptInput {
  repoFull: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  issueNumber: number;
  callbackUrl: string;
  timeoutMinutes: number;
  testCommand: string;
  model: string;
  /** Run agent; defaults to opencode. */
  agent?: string;
  /** Control-plane LLM gateway base URL for the model's provider. */
  gatewayUrl: string;
  presentInstructionFiles?: string[];
  resumeBranch?: boolean;
  envelope: { issue: string; system: string; constraints: string };
  /** Guest path and git host overrides; production uses the defaults. */
  workDir?: string;
  artifactDir?: string;
  gitHost?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Untrusted text never meets a heredoc or a quote: it travels as base64 only. */
function writeFile(path: string, content: string): string {
  return `printf '%s' '${Buffer.from(content, 'utf8').toString('base64')}' | base64 -d > ${path}`;
}

/**
 * Synchronous first exec, the only phase holding a GitHub credential: a
 * read-only clone token via credential helper. It clones, records the start
 * commit, and stages every file the detached runner needs; its process and
 * token are gone before the agent starts.
 */
export function buildPrepareScript(input: RunnerScriptInput): string {
  const art = input.artifactDir ?? RUN_ARTIFACT_DIR;
  const branchRef = shellQuote(`refs/heads/${input.branch}`);
  const branchSetup = input.resumeBranch
    ? `if git "\${AUTH[@]}" -C "$RUN_DIR" ls-remote --exit-code origin ${branchRef} >/dev/null 2>&1; then git "\${AUTH[@]}" -C "$RUN_DIR" fetch origin ${branchRef} && git -C "$RUN_DIR" checkout -B "$BRANCH" FETCH_HEAD; else git -C "$RUN_DIR" checkout -b "$BRANCH"; fi`
    : 'git -C "$RUN_DIR" checkout -b "$BRANCH"';
  return [
    'set -eu',
    `RUN_DIR=${shellQuote(input.workDir ?? RUN_WORK_DIR)}`,
    `ART=${shellQuote(art)}`,
    'DOCK_DIR="$RUN_DIR/.dock"',
    `BRANCH=${shellQuote(input.branch)}`,
    'mkdir -p "$ART" "$RUN_DIR"',
    'AUTH=(-c credential.helper= -c \'credential.helper=!f() { echo username=x-access-token; echo "password=${GITHUB_CLONE_TOKEN}"; }; f\')',
    `git "\${AUTH[@]}" clone --quiet --no-tags --branch ${shellQuote(input.baseBranch)} ${shellQuote(`${input.gitHost ?? 'https://github.com'}/${input.repoFull}.git`)} "$RUN_DIR"`,
    `git -C "$RUN_DIR" checkout --quiet ${shellQuote(input.baseSha)}`,
    branchSetup,
    'git -C "$RUN_DIR" rev-parse HEAD > "$ART/start.sha"',
    "git -C \"$RUN_DIR\" config user.name 'dock-fix[bot]'",
    "git -C \"$RUN_DIR\" config user.email 'dock-fix[bot]@users.noreply.github.com'",
    'mkdir -p "$DOCK_DIR"',
    "echo '.dock/' >> \"$RUN_DIR/.git/info/exclude\"",
    writeFile('"$DOCK_DIR/ISSUE.md"', input.envelope.issue),
    writeFile('"$DOCK_DIR/CONSTRAINTS.md"', input.envelope.constraints),
    writeFile('"$ART/SYSTEM.md"', input.envelope.system),
    ...(input.agent === 'codex'
      ? [
          'mkdir -p "$ART/codex"',
          writeFile('"$ART/codex/config.toml"', buildCodexConfig(input.model, input.gatewayUrl)),
          writeFile('"$ART/PROMPT.md"', `${input.envelope.system}\n\n${codexTask(input)}\n`),
        ]
      : [writeFile('"$ART/opencode.json"', buildAgentConfig(input.model, input.gatewayUrl, art))]),
    writeFile('"$ART/finish.py"', FINISH_PY),
    writeFile('"$ART/runner.sh"', buildRunnerScript(input)),
  ].join('\n');
}

/** Codex reads no --file flags, so the task names the envelope files and repo instruction files it must read. */
function codexTask(input: RunnerScriptInput): string {
  const present = (input.presentInstructionFiles ?? []).filter((f) => (REPO_INSTRUCTION_FILES as readonly string[]).includes(f));
  const read = ['.dock/ISSUE.md', '.dock/CONSTRAINTS.md', ...present].join(', ');
  return `Fix issue #${input.issueNumber}. Read ${read} first, follow .dock/CONSTRAINTS.md, and write .dock/RESULT.json when done.`;
}

/** The agent invocation; its events go to events.ndjson and its log to <agent>.log. */
function agentCommand(input: RunnerScriptInput, fileArgs: string, task: string): string {
  if (input.agent === 'codex') {
    return `env -u GITHUB_COMPLETION_TOKEN CODEX_HOME="$ART/codex" timeout ${input.timeoutMinutes}m "$AGENT" exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral -C "$RUN_DIR" -m ${shellQuote(modelId(input.model))} - < "$ART/PROMPT.md" > "$ART/events.ndjson" 2> "$ART/codex.log"`;
  }
  return `env -u GITHUB_COMPLETION_TOKEN ${providerOf(input.model) === 'chatgpt' ? `${chatgptAuthEnv()} ` : ''}OPENCODE_CONFIG="$ART/opencode.json" timeout ${input.timeoutMinutes}m "$AGENT" run ${shellQuote(task)} --dir "$RUN_DIR" --agent dock-fix --model ${shellQuote(agentModel(input.model))} --format json ${fileArgs} < /dev/null > "$ART/events.ndjson" 2> "$ART/opencode.log"`;
}

/**
 * Detached runner: the agent under a timeout, a change snapshot before the
 * harness tests run, then the completion callback from an EXIT trap so every
 * outcome reports. It never holds a GitHub credential.
 */
export function buildRunnerScript(input: RunnerScriptInput): string {
  const present = (input.presentInstructionFiles ?? []).filter((f) => (REPO_INSTRUCTION_FILES as readonly string[]).includes(f));
  // --file is a greedy array flag: the message must come before it.
  const fileArgs = ['"$DOCK_DIR/ISSUE.md"', '"$DOCK_DIR/CONSTRAINTS.md"', ...present.map((f) => `"$RUN_DIR"/${shellQuote(f)}`)]
    .map((f) => `--file ${f}`)
    .join(' ');
  const task = `Fix issue #${input.issueNumber} described in .dock/ISSUE.md, following .dock/CONSTRAINTS.md. Write .dock/RESULT.json when done.`;
  const agentName = input.agent ?? 'opencode';
  return [
    'set -u',
    `RUN_DIR=${shellQuote(input.workDir ?? RUN_WORK_DIR)}`,
    `ART=${shellQuote(input.artifactDir ?? RUN_ARTIFACT_DIR)}`,
    'DOCK_DIR="$RUN_DIR/.dock"',
    `CALLBACK_URL=${shellQuote(input.callbackUrl)}`,
    'STAGE=agent_missing',
    'finish() {',
    '  trap - EXIT',
    `  python3 "$ART/finish.py" emit "$ART" "$DOCK_DIR" "$RUN_DIR" "$STAGE" ${input.issueNumber} > "$ART/RESULT.json" 2>> "$ART/runner.log" || printf '%s' '{"status":"failed","reason":"runner_failed"}' > "$ART/RESULT.json"`,
    '  curl -fsS --retry 5 --retry-all-errors --max-time 60 -X POST "$CALLBACK_URL" -H "authorization: Bearer $GITHUB_COMPLETION_TOKEN" -H \'content-type: application/json\' --data-binary @"$ART/RESULT.json" >> "$ART/runner.log" 2>&1 || true',
    '}',
    'trap finish EXIT',
    'set -e',
    // Dock installs no agents: the environment's setup script must provide it.
    `command -v dock-agent-${agentName} >/dev/null 2>&1 || command -v ${agentName} >/dev/null 2>&1 || { echo ${shellQuote(`${agentName} is not installed in this dock; install it in your environment setup script`)} >> "$ART/runner.log"; exit 1; }`,
    `AGENT="$(command -v dock-agent-${agentName} || command -v ${agentName})"`,
    'STAGE=agent',
    'set +e',
    `(cd "$RUN_DIR" && ${agentCommand(input, fileArgs, task)})`,
    'echo $? > "$ART/agent.exit"',
    'STAGE=collect',
    'python3 "$ART/finish.py" collect "$ART" "$DOCK_DIR" "$RUN_DIR" > "$ART/changes.json" 2>> "$ART/runner.log" || exit 1',
    `(cd "$RUN_DIR" && env -u GITHUB_COMPLETION_TOKEN -u DOCK_LLM_TOKEN sh -c ${shellQuote(input.testCommand)} > "$ART/test.log" 2>&1 < /dev/null)`,
    'echo $? > "$ART/test.exit"',
    'STAGE=done',
  ].join('\n');
}

/** Second exec: detaches the staged runner so no fleet deadline bounds the agent. */
export function buildLaunchScript(artifactDir: string = RUN_ARTIFACT_DIR): string {
  const art = shellQuote(artifactDir);
  return `setsid nohup bash ${art}/runner.sh > ${art}/runner.log 2>&1 < /dev/null &`;
}

/** Prepare payload must fit the exec channel ceiling. */
export function assertRunnerFits(script: string): void {
  if (Buffer.byteLength(script, 'utf8') > RUNNER_SCRIPT_MAX_BYTES) {
    throw new Error('runner script exceeds 256KB');
  }
}
