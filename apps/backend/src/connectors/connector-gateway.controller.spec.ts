import { vi } from 'vitest';
import { ConnectorGatewayController } from './connector-gateway.controller';

function mockRes() {
  const chunks: Buffer[] = [];
  const res: Record<string, any> = {
    headers: {} as Record<string, string>,
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn((k: string, v: string) => (res.headers[k] = v)),
    flushHeaders: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    chunks,
  };
  return res;
}

describe('ConnectorGatewayController', () => {
  it('relays status and safe headers only, never credentials or cookies', async () => {
    const upstream = new Response(null, {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'www-authenticate': 'Bearer', authorization: 'Bearer leak', 'mcp-session-id': 's1', 'x-secret': 'x' },
    });
    const gateway = { forward: vi.fn().mockResolvedValue({ response: upstream, target: 'api' }) };
    const ctrl = new ConnectorGatewayController(gateway as never);
    const res = mockRes();
    await ctrl.proxy('linear', { params: { path: ['api', 'graphql'] }, originalUrl: '/v1/connectors/gateway/linear/api/graphql?a=1', method: 'POST', headers: {}, body: Buffer.from('x') } as never, res as never);
    expect(gateway.forward).toHaveBeenCalledWith(expect.objectContaining({ kind: 'linear', path: 'api/graphql', query: '?a=1', method: 'POST' }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.headers).toEqual({ 'content-type': 'application/json', 'mcp-session-id': 's1' });
    expect(res.end).toHaveBeenCalled();
  });
});
