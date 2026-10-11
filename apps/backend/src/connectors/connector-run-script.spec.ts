import { buildConnectorRunScript, renderConnectorPrompt } from './connector-run-script';

const decodedFiles = (script: string): string[] =>
  [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));

describe('renderConnectorPrompt', () => {
  it('sanitizes the untrusted event text and names the tool env vars', () => {
    const text = renderConnectorPrompt({ kind: 'linear', title: 'Fix <b>it</b>', body: 'hello​ <script>x</script> world', url: 'https://linear.app/i/1', timeoutMinutes: 20 });
    expect(text).toContain('Request: Fix it');
    expect(text).toContain('hello x world');
    expect(text).not.toContain('<script>');
    expect(text).toContain('$DOCK_LINEAR_API_URL');
    expect(text).toContain('INPUT TRUST');
    expect(text).toContain('RESULT.json');
  });

  it('bounds an oversized body', () => {
    const text = renderConnectorPrompt({ kind: 'slack', title: 't', body: 'a'.repeat(40_000), url: null, timeoutMinutes: 5 });
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('[truncated');
  });
});

describe('buildConnectorRunScript', () => {
  const input = { prompt: 'do the thing', callbackUrl: 'https://api.example.test/v1/connectors/runs/r1/complete', agent: 'opencode', model: null, timeoutMinutes: 30 };

  it('stages the prompt and a detached runner, with the token only as an env reference', () => {
    const script = buildConnectorRunScript(input);
    const [prompt, , runner] = decodedFiles(script);
    expect(prompt).toBe('do the thing');
    expect(runner).toContain("https://api.example.test/v1/connectors/runs/r1/complete");
    expect(runner).toContain('authorization: Bearer $CONNECTOR_RUN_TOKEN');
    expect(runner).toContain('trap finish EXIT');
    expect(runner).toContain('timeout 30m "$AGENT" run');
    expect(script).toContain('setsid nohup bash');
  });

  it('runs codex with its exec subcommand and passes a model through quoted', () => {
    const [, , runner] = decodedFiles(buildConnectorRunScript({ ...input, agent: 'codex', model: "gpt-5'x" }));
    expect(runner).toContain('"$AGENT" exec --json');
    expect(runner).toContain("-m 'gpt-5'\\''x'");
  });

  it('tells the user to install the agent when it is missing', () => {
    const [, , runner] = decodedFiles(buildConnectorRunScript(input));
    expect(runner).toContain('is not installed in this dock');
  });
});
