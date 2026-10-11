import { DOCK_USER_HOME } from '../github/runner';
import { CONNECTOR_SPECS, envStem, type ConnectorKind } from './connector-kinds';

export const MCP_CONFIG_PATH = '.config/dock/mcp.json';

/** Env and files that point a dock's tools at the gateway with a dock-scoped token; no vendor credential enters the guest. */
export function connectorDockBundle(token: string, gatewayUrl: string, kinds: ConnectorKind[]) {
  const vars: Record<string, string> = {
    DOCK_CONNECTOR_TOKEN: token,
    DOCK_CONNECTORS_URL: gatewayUrl,
    DOCK_CONNECTORS: kinds.join(','),
    DOCK_MCP_CONFIG: `${DOCK_USER_HOME}/${MCP_CONFIG_PATH}`,
  };
  const servers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> = {};
  for (const kind of kinds) {
    vars[`DOCK_${envStem(kind)}_API_URL`] = `${gatewayUrl}/${kind}/api`;
    if (CONNECTOR_SPECS[kind].mcp) {
      const url = `${gatewayUrl}/${kind}/mcp`;
      vars[`DOCK_${envStem(kind)}_MCP_URL`] = url;
      servers[kind] = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
    }
  }
  const files = [{ path: MCP_CONFIG_PATH, contents: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n` }];
  return { vars, files };
}
