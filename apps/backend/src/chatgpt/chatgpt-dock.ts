import { DOCK_USER_HOME, agentModel, buildCodexConfig } from '../github/runner';

/** Dock agents that can speak through the ChatGPT gateway route. */
export const CHATGPT_DOCK_AGENTS = ['codex', 'opencode'] as const;
export const CHATGPT_DOCK_MODEL = 'chatgpt/gpt-5.5';
const CODEX_DIR = '.dock/codex';

/**
 * Env and files pointing a dock's codex and opencode at the gateway's
 * ChatGPT route with a dock-scoped token; no ChatGPT credential enters the
 * guest. The opencode entry mirrors the run runner: an OAuth record whose
 * access token is the gateway token, at a base URL opencode never rewrites.
 */
export function chatgptDockBundle(token: string, gatewayUrl: string, agents: string[]) {
  const vars: Record<string, string> = { DOCK_LLM_TOKEN: token };
  const files: { path: string; contents: string }[] = [];
  if (agents.includes('codex')) {
    vars.CODEX_HOME = `${DOCK_USER_HOME}/${CODEX_DIR}`;
    files.push({ path: `${CODEX_DIR}/config.toml`, contents: buildCodexConfig(CHATGPT_DOCK_MODEL, gatewayUrl) });
  }
  if (agents.includes('opencode')) {
    vars.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: 'oauth', access: token, refresh: 'dock-gateway', expires: 4102444800000 } });
    vars.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { openai: { options: { baseURL: gatewayUrl } } }, model: agentModel(CHATGPT_DOCK_MODEL) });
  }
  return { vars, files };
}
