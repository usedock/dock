import { PROVIDER_ENV_VARS, type ProviderName } from '../database/schema';

/** Env var that points each provider's SDK at the gateway, and the opencode provider ids that take a base URL. */
const BASE_URL_VARS: Partial<Record<ProviderName, string>> = { anthropic: 'ANTHROPIC_BASE_URL', openai: 'OPENAI_BASE_URL' };
const OPENCODE_PROVIDERS: Record<ProviderName, { gatewayPath: string; ids: string[] }[]> = {
  anthropic: [{ gatewayPath: 'anthropic', ids: ['anthropic'] }],
  openai: [{ gatewayPath: 'openai', ids: ['openai'] }],
  openrouter: [],
  opencode: [
    { gatewayPath: 'opencode', ids: ['opencode'] },
    { gatewayPath: 'opencode-go', ids: ['opencode-go'] },
  ],
};

/**
 * Env that points a dock's model clients at the gateway. Key variables carry
 * the dock-scoped gateway token, which the gateway recognizes and swaps for
 * the organization's real key; the provider key itself never enters the guest.
 */
export function providerGatewayBundle(token: string, gatewayUrl: string, providers: ProviderName[], opencodeConfig?: string) {
  const vars: Record<string, string> = { DOCK_LLM_TOKEN: token };
  const opencode: Record<string, { options: { baseURL: string } }> = {};
  for (const provider of providers) {
    for (const name of PROVIDER_ENV_VARS[provider]) vars[name] = token;
    const baseUrlVar = BASE_URL_VARS[provider];
    if (baseUrlVar) vars[baseUrlVar] = `${gatewayUrl}/${provider}`;
    for (const { gatewayPath, ids } of OPENCODE_PROVIDERS[provider]) {
      for (const id of ids) opencode[id] = { options: { baseURL: `${gatewayUrl}/${gatewayPath}` } };
    }
  }
  if (Object.keys(opencode).length) {
    // Entries already in the opencode config (the ChatGPT route) win over the gateway defaults.
    const existing = opencodeConfig ? (JSON.parse(opencodeConfig) as { provider?: Record<string, unknown> }) : {};
    vars.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...existing, provider: { ...opencode, ...existing.provider } });
  } else if (opencodeConfig) {
    vars.OPENCODE_CONFIG_CONTENT = opencodeConfig;
  }
  return { vars };
}
