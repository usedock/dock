import { buildConnectorRunScript, renderConnectorRequest, renderConnectorSystem } from './connector-run-script';

const decodedFiles = (script: string): string[] =>
  [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));

describe('renderConnectorRequest', () => {
  it('sanitizes the untrusted event text', () => {
    const text = renderConnectorRequest({ title: 'Fix <b>it</b>', body: 'hello​ <script>x</script> world', url: 'https://linear.app/i/1' });
    expect(text).toContain('Request: Fix it');
    expect(text).toContain('hello x world');
    expect(text).not.toContain('<script>');
    expect(text).toContain('Link: https://linear.app/i/1');
  });

  it('bounds an oversized body', () => {
    const text = renderConnectorRequest({ title: 't', body: 'a'.repeat(40_000), url: null });
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('[truncated');
  });
});

describe('renderConnectorSystem', () => {
  it('is trusted instruction text that names the tool env vars and forbids revealing secrets', () => {
    const text = renderConnectorSystem({ kind: 'linear', timeoutMinutes: 20 });
    expect(text).toContain('$DOCK_LINEAR_API_URL');
    expect(text).toContain('INPUT TRUST');
    expect(text).toContain('Never print, echo or reveal environment variables');
    expect(text).toContain('RESULT.json');
  });
});

describe('buildConnectorRunScript', () => {
  const input = {
    system: 'SYSTEM TEXT',
    request: 'do the thing',
    callbackUrl: 'https://api.example.test/v1/connectors/runs/r1/complete',
    agent: 'opencode',
    model: 'anthropic/claude-sonnet-5',
    gatewayUrl: 'https://api.example.test/v1/llm/anthropic',
    timeoutMinutes: 30,
  };
  const files = (over: Partial<typeof input> = {}) => decodedFiles(buildConnectorRunScript({ ...input, ...over }));
  const runner = (over: Partial<typeof input> = {}) => files(over).find((f) => f.includes('trap finish EXIT')) as string;

  it('stages the prompts and a detached runner with only env references to tokens', () => {
    const script = buildConnectorRunScript(input);
    const all = decodedFiles(script);
    expect(all).toContain('SYSTEM TEXT');
    expect(all).toContain('do the thing');
    expect(runner()).toContain('https://api.example.test/v1/connectors/runs/r1/complete');
    expect(runner()).toContain('authorization: Bearer $CONNECTOR_RUN_TOKEN');
    expect(runner()).toContain('timeout 30m "$AGENT" run');
    expect(script).toContain('setsid nohup bash');
  });

  it('points opencode at the LLM gateway with the run token and never at a provider key', () => {
    const config = JSON.parse(files().find((f) => f.startsWith('{"$schema"')) as string);
    expect(config.provider.anthropic.options).toEqual({ baseURL: 'https://api.example.test/v1/llm/anthropic', apiKey: '{env:DOCK_LLM_TOKEN}' });
    expect(runner()).toContain('--model');
    const joined = files().join('\n');
    expect(joined).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENCODE_API_KEY/);
  });

  it('keeps the completion token away from the agent process', () => {
    expect(runner()).toContain('env -u CONNECTOR_RUN_TOKEN');
    expect(runner({ agent: 'codex', model: 'openai/gpt-5' })).toContain('env -u CONNECTOR_RUN_TOKEN');
  });

  it('runs codex with its exec subcommand against the gateway and quotes the model', () => {
    const all = files({ agent: 'codex', model: "openai/gpt-5'x" });
    expect(all.some((f) => f.includes('env_key = "DOCK_LLM_TOKEN"') && f.includes('/v1/llm/anthropic'))).toBe(true);
    expect(runner({ agent: 'codex', model: "openai/gpt-5'x" })).toContain("-m 'gpt-5'\\''x'");
    expect(runner({ agent: 'codex' })).toContain('"$AGENT" exec --json');
  });

  it('scrubs secret-looking env values from the reported summary inside the dock too', () => {
    const callback = files().find((f) => f.includes('def scrub')) as string;
    expect(callback).toContain('DOCK_CONNECTOR_TOKEN');
    expect(callback).toContain('KEY|TOKEN|SECRET|PASSWORD');
  });

  it('waits for the agent to be installed and says so when it never is', () => {
    expect(runner()).toContain('seq 1 60');
    expect(runner()).toContain('is not installed in this dock');
  });
});
