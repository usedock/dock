import { ConfigService } from '@nestjs/config';
import { RestateClient } from './restate.client';

const config = () => ({ get: (key: string) => (key === 'RESTATE_INGRESS_URL' ? 'http://restate:8080/' : undefined) }) as unknown as ConfigService;

describe('RestateClient', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = realFetch;
  });

  it('addresses keyed handlers as /service/key/handler', async () => {
    const seen: string[] = [];
    (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ done: true }) };
    };
    const client = new RestateClient(config());
    await expect(client.call('DockService', 'stop', { dockId: 'd1' }, 'd1')).resolves.toEqual({ done: true });
    expect(seen).toEqual(['http://restate:8080/DockService/d1/stop']);
  });

  it('addresses unkeyed handlers as /service/handler', async () => {
    const seen: string[] = [];
    (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({}) };
    };
    await new RestateClient(config()).call('Ops', 'ping', {});
    expect(seen).toEqual(['http://restate:8080/Ops/ping']);
  });

  it('throws the ingress status on failure', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => ({ ok: false, status: 500 });
    await expect(new RestateClient(config()).call('DockService', 'stop', {})).rejects.toMatchObject({ status: 500 });
  });

  it('reports unhealthy instead of throwing when unreachable', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error('down');
    };
    await expect(new RestateClient(config()).health()).resolves.toBe(false);
  });
});
