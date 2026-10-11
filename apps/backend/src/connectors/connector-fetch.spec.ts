import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeniedAddressError } from '../webhooks/ssrf-guard';
import { createConnectorFetch } from './connector-fetch';

describe('createConnectorFetch', () => {
  let server: Server;
  let connections: number;
  let port: number;

  beforeEach(async () => {
    connections = 0;
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((res) => server.close(() => res())));

  it('keeps vendor hosts on the runtime fetch', async () => {
    const base = vi.fn().mockResolvedValue(new Response('ok'));
    await createConnectorFetch(async () => ['127.0.0.1'], base as never)('https://api.linear.app/graphql', { method: 'POST' });
    expect(base).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a self-hosted host that now resolves to loopback', () => `https://sentry.example.com:${port}/api/0/`],
    ['a literal private IP', () => `https://127.0.0.1:${port}/api/0/`],
  ])('refuses %s without opening a connection', async (_name, url) => {
    const base = vi.fn();
    // The earlier host check passed; the address vetted at dial time is private.
    await expect(createConnectorFetch(async () => ['127.0.0.1'], base as never)(url())).rejects.toBeInstanceOf(DeniedAddressError);
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
    expect(base).not.toHaveBeenCalled();
  });

  it('refuses a non-https URL', async () => {
    await expect(createConnectorFetch(async () => ['203.0.113.9'])('http://sentry.example.com/api/0/')).rejects.toThrow('https');
  });
});
