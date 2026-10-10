import { chatgptDockBundle } from './chatgpt-dock';

describe('chatgptDockBundle', () => {
  const url = 'https://api.example.test/v1/llm/chatgpt';

  it('points codex at a Dock-managed CODEX_HOME whose config uses the dock token by env name', () => {
    const { vars, files } = chatgptDockBundle('tok', url, ['codex']);
    expect(vars).toEqual({ DOCK_LLM_TOKEN: 'tok', CODEX_HOME: '/home/user/.dock/codex' });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('.dock/codex/config.toml');
    expect(files[0].contents).toContain('env_key = "DOCK_LLM_TOKEN"');
    expect(files[0].contents).not.toContain('tok"');
  });

  it("gives opencode an OAuth record holding only the dock token, at the gateway's base URL", () => {
    const { vars, files } = chatgptDockBundle('tok', url, ['opencode']);
    expect(files).toEqual([]);
    expect(JSON.parse(vars.OPENCODE_AUTH_CONTENT)).toEqual({ openai: { type: 'oauth', access: 'tok', refresh: 'dock-gateway', expires: 4102444800000 } });
    expect(JSON.parse(vars.OPENCODE_CONFIG_CONTENT)).toEqual({ provider: { openai: { options: { baseURL: url } } }, model: 'openai/gpt-5.5' });
    expect(new URL(url).pathname).not.toContain('/v1/responses');
  });
});
