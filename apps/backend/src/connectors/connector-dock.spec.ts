import { connectorDockBundle } from './connector-dock';

describe('connectorDockBundle', () => {
  const gw = 'https://api.example.test/v1/connectors/gateway';

  it('points per-kind URLs at the gateway and lists only kinds with an MCP endpoint in the MCP config', () => {
    const { vars, files } = connectorDockBundle('tok', gw, ['linear', 'slack']);
    expect(vars).toMatchObject({
      DOCK_CONNECTOR_TOKEN: 'tok',
      DOCK_CONNECTORS_URL: gw,
      DOCK_CONNECTORS: 'linear,slack',
      DOCK_LINEAR_API_URL: `${gw}/linear/api`,
      DOCK_LINEAR_MCP_URL: `${gw}/linear/mcp`,
      DOCK_SLACK_API_URL: `${gw}/slack/api`,
      DOCK_MCP_CONFIG: '/home/user/.config/dock/mcp.json',
    });
    expect(vars.DOCK_SLACK_MCP_URL).toBeUndefined();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('.config/dock/mcp.json');
    expect(JSON.parse(files[0].contents)).toEqual({
      mcpServers: { linear: { type: 'http', url: `${gw}/linear/mcp`, headers: { Authorization: 'Bearer tok' } } },
    });
  });
});
