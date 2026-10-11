import { providerGatewayBundle } from './provider-gateway-dock';

const GW = 'https://api.example.test/v1/llm';

describe('providerGatewayBundle', () => {
  it('sets the token as the key and base URLs per provider', () => {
    const { vars } = providerGatewayBundle('tok', GW, ['anthropic', 'openai']);
    expect(vars).toMatchObject({
      DOCK_LLM_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'tok',
      ANTHROPIC_BASE_URL: `${GW}/anthropic`,
      OPENAI_API_KEY: 'tok',
      OPENAI_BASE_URL: `${GW}/openai`,
    });
    expect(JSON.parse(vars.OPENCODE_CONFIG_CONTENT).provider.anthropic.options.baseURL).toBe(`${GW}/anthropic`);
  });

  it('keeps entries already in the opencode config, such as the ChatGPT route', () => {
    const existing = JSON.stringify({ model: 'openai/gpt-5.5', provider: { openai: { options: { baseURL: `${GW}/chatgpt` } } } });
    const { vars } = providerGatewayBundle('tok', GW, ['openai', 'opencode'], existing);
    const config = JSON.parse(vars.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe('openai/gpt-5.5');
    expect(config.provider.openai.options.baseURL).toBe(`${GW}/chatgpt`);
    expect(config.provider['opencode-go'].options.baseURL).toBe(`${GW}/opencode-go`);
    expect(vars.OPENCODE_API_KEY).toBe('tok');
  });

  it('writes nothing for no providers', () => {
    expect(providerGatewayBundle('tok', GW, []).vars).toEqual({ DOCK_LLM_TOKEN: 'tok' });
  });
});
