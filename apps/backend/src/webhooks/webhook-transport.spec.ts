import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeniedAddressError } from './ssrf-guard';
import { PinnedHttpsWebhookTransport } from './webhook-transport';

describe('PinnedHttpsWebhookTransport', () => {
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

  const post = (url: string) =>
    new PinnedHttpsWebhookTransport(async () => ['127.0.0.1']).post({ url, body: '{}', headers: {}, timeoutMs: 2000 });

  it.each([
    ['a hostname resolving to loopback', () => `https://rebind.invalid:${port}/`],
    ['a literal loopback IP', () => `https://127.0.0.1:${port}/`],
    ['a decimal-encoded loopback IP', () => `https://2130706433:${port}/`],
  ])('refuses %s without opening a connection', async (_name, url) => {
    await expect(post(url())).rejects.toBeInstanceOf(DeniedAddressError);
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
  });
});
