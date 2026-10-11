import { vi, type Mock } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { ConnectorNotConnectedException } from './connectors.service';
import { ConnectorGatewayService, resolveUpstream } from './connector-gateway.service';

const DOCK_TOKEN = 'a'.repeat(64);
const REAL_TOKEN = 'lin_real_secret';

function selectQ(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}

describe('resolveUpstream', () => {
  it('maps api and mcp targets onto the fixed vendor hosts', () => {
    expect(resolveUpstream('figma', 'api/v1/files/abc', '?depth=1')).toEqual({ url: 'https://api.figma.com/v1/files/abc?depth=1', target: 'api' });
    // mcp.figma.com admits only catalog OAuth clients, so Figma has no MCP target.
    expect(resolveUpstream('figma', 'mcp', '')).toBeNull();
    expect(resolveUpstream('linear', 'api/graphql', '')?.url).toBe('https://api.linear.app/graphql');
    expect(resolveUpstream('linear', 'mcp', '')?.url).toBe('https://mcp.linear.app/mcp');
    expect(resolveUpstream('slack', 'api/chat.postMessage', '')?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(resolveUpstream('sentry', 'api/0/organizations/', '')?.url).toBe('https://sentry.io/api/0/organizations/');
    expect(resolveUpstream('sentry', 'mcp', '')?.url).toBe('https://mcp.sentry.dev/mcp');
    expect(resolveUpstream('sentry', 'api/0/organizations/', '', 'https://de.sentry.io')?.url).toBe('https://de.sentry.io/api/0/organizations/');
    expect(resolveUpstream('sentry', 'api/0/organizations/', '', 'https://sentry.example.com')?.url).toBe('https://sentry.example.com/api/0/organizations/');
    expect(resolveUpstream('linear', 'api/graphql', '', 'https://evil.example')?.url).toBe('https://api.linear.app/graphql');
  });

  it('refuses paths outside each allowlist, traversal, odd characters and unknown targets', () => {
    expect(resolveUpstream('slack', 'mcp', '')).toBeNull();
    expect(resolveUpstream('linear', 'api/oauth/token', '')).toBeNull();
    expect(resolveUpstream('figma', 'api/oauth/token', '')).toBeNull();
    expect(resolveUpstream('sentry', 'api/1/x', '')).toBeNull();
    expect(resolveUpstream('slack', 'api/a/b', '')).toBeNull();
    expect(resolveUpstream('figma', 'api/v1/../oauth/token', '')).toBeNull();
    expect(resolveUpstream('figma', 'api/v1/%2e%2e/x', '')).toBeNull();
    expect(resolveUpstream('figma', 'api//evil.example/x', '')).toBeNull();
    expect(resolveUpstream('figma', 'api/v1/@evil.example', '')).toBeNull();
    expect(resolveUpstream('figma', 'other/v1/me', '')).toBeNull();
    expect(resolveUpstream('figma', '', '')).toBeNull();
  });
});

describe('ConnectorGatewayService', () => {
  let db: { select: Mock };
  let connectors: { accessFor: Mock };
  let limits: { hit: Mock };
  let fetchFn: Mock;
  let service: ConnectorGatewayService;
  const dock = (over: Record<string, unknown> = {}) => ({ id: 'd1', workspaceId: 'w1', state: 'ready', connectors: ['linear'], ...over });
  const req = (over: Record<string, unknown> = {}) => ({
    kind: 'linear',
    path: 'api/graphql',
    query: '',
    method: 'POST',
    headers: { authorization: `Bearer ${DOCK_TOKEN}`, 'content-type': 'application/json' } as Record<string, string>,
    body: Buffer.from('{"query":"{ viewer { id } }"}'),
    ...over,
  });

  beforeEach(() => {
    db = { select: vi.fn().mockReturnValue(selectQ([dock()])) };
    connectors = { accessFor: vi.fn().mockResolvedValue({ type: 'oauth', access: REAL_TOKEN }) };
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    fetchFn = vi.fn().mockResolvedValue(new Response('{"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
    service = new ConnectorGatewayService(db as never, connectors as never, limits as never, { fetchFn: fetchFn as never });
  });

  it('swaps the dock token for the real credential and forwards only allowlisted headers', async () => {
    const out = await service.forward(req({
      headers: { authorization: `Bearer ${DOCK_TOKEN}`, 'content-type': 'application/json', cookie: 'sid=1', 'x-api-key': 'k', 'x-forwarded-for': '1.2.3.4', host: 'api.dock', 'mcp-session-id': 's1' },
    }));
    expect(out.response.status).toBe(200);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'mcp-session-id': 's1', authorization: `Bearer ${REAL_TOKEN}` });
    expect(JSON.stringify(init.headers)).not.toContain(DOCK_TOKEN);
    expect(connectors.accessFor).toHaveBeenCalledWith('w1', 'linear');
    expect(db.select).toHaveBeenCalled();
    expect(hashToken(DOCK_TOKEN)).toHaveLength(64);
  });

  it('uses the vendor personal-token scheme only on the api host', async () => {
    connectors.accessFor.mockResolvedValue({ type: 'token', access: 'lin_api_x' });
    await service.forward(req());
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe('lin_api_x');
    await service.forward(req({ path: 'mcp' }));
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer lin_api_x');
  });

  it('sends Sentry tokens to its MCP server as Sentry-Bearer, which reserves Bearer for its own OAuth', async () => {
    db.select.mockReturnValue(selectQ([dock({ connectors: ['sentry'] })]));
    connectors.accessFor.mockResolvedValue({ type: 'token', access: 'sntryu_x' });
    await service.forward(req({ kind: 'sentry', path: 'mcp' }));
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe('Sentry-Bearer sntryu_x');
    await service.forward(req({ kind: 'sentry', path: 'api/0/organizations/', method: 'GET' }));
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer sntryu_x');
  });

  it('refuses archived and errored docks', async () => {
    for (const state of ['archived', 'archiving', 'error', 'unreachable', 'provisioning']) {
      db.select.mockReturnValue(selectQ([dock({ state })]));
      await expect(service.forward(req())).rejects.toMatchObject({ status: 401 });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a missing, malformed, unknown or stopped dock token', async () => {
    await expect(service.forward(req({ headers: {} }))).rejects.toMatchObject({ response: { code: 'invalid_connector_token' } });
    await expect(service.forward(req({ headers: { authorization: 'Basic abc' } }))).rejects.toMatchObject({ status: 401 });
    db.select.mockReturnValue(selectQ([]));
    await expect(service.forward(req())).rejects.toMatchObject({ status: 401 });
    db.select.mockReturnValue(selectQ([dock({ state: 'stopped' })]));
    await expect(service.forward(req())).rejects.toMatchObject({ status: 401 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses kinds the dock was not created with and unknown kinds', async () => {
    await expect(service.forward(req({ kind: 'slack', path: 'api/chat.postMessage' }))).rejects.toMatchObject({ status: 403, response: { code: 'connector_not_enabled' } });
    await expect(service.forward(req({ kind: 'jira' }))).rejects.toMatchObject({ status: 400 });
    expect(connectors.accessFor).not.toHaveBeenCalled();
  });

  it('refuses a disconnected kind', async () => {
    connectors.accessFor.mockRejectedValue(new ConnectorNotConnectedException(['linear']));
    await expect(service.forward(req())).rejects.toMatchObject({ response: { code: 'connector_not_connected' } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses paths off the allowlist without contacting the vendor', async () => {
    await expect(service.forward(req({ path: 'api/oauth/token' }))).rejects.toMatchObject({ status: 400 });
    await expect(service.forward(req({ path: 'api/../x' }))).rejects.toMatchObject({ status: 400 });
    db.select.mockReturnValue(selectQ([dock({ connectors: ['slack'] })]));
    await expect(service.forward(req({ kind: 'slack', path: 'mcp' }))).rejects.toMatchObject({ status: 404, response: { code: 'connector_target_unsupported' } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never follows or relays an upstream redirect', async () => {
    fetchFn.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    await expect(service.forward(req())).rejects.toMatchObject({ status: 502, response: { code: 'connector_upstream_redirect' } });
  });

  it('maps network failures to 502 and enforces the per-dock budget', async () => {
    fetchFn.mockRejectedValue(new Error('boom'));
    await expect(service.forward(req())).rejects.toMatchObject({ status: 502, response: { code: 'connector_unreachable' } });
    limits.hit.mockResolvedValue({ allowed: false, count: 3001 });
    await expect(service.forward(req())).rejects.toMatchObject({ status: 429 });
  });

  it('does not send a body on GET', async () => {
    await service.forward(req({ method: 'GET', kind: 'linear', path: 'mcp' }));
    expect(fetchFn.mock.calls[0][1].body).toBeUndefined();
  });
});
