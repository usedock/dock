import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeniedAddressError } from '../webhooks/ssrf-guard';
import { createConnectorFetch } from './connector-fetch';

const fakeRequest = vi.hoisted(() => ({ impl: null as null | ((...args: unknown[]) => unknown) }));
vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>();
  return { ...real, request: (...args: unknown[]) => (fakeRequest.impl ?? (real.request as (...a: unknown[]) => unknown))(...args) };
});

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
  afterEach(() => {
    fakeRequest.impl = null;
    return new Promise<void>((res) => server.close(() => res()));
  });

  it('keeps vendor hosts on the runtime fetch', async () => {
    const base = vi.fn().mockResolvedValue(new Response('ok'));
    await createConnectorFetch(async () => ['127.0.0.1'], base as never)('https://api.linear.app/graphql', { method: 'POST' });
    expect(base).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a self-hosted host that now resolves to loopback', () => `https://sentry.example.com:${port}/api/0/`],
    ['a literal private IP', () => `https://127.0.0.1:${port}/api/0/`],
    ['an IPv4-mapped IPv6 loopback literal', () => `https://[::ffff:127.0.0.1]:${port}/api/0/`],
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

  it('rejects, instead of throwing out of the socket callback, when the upstream status is outside 200-599', async () => {
    const res = Object.assign(Readable.from([Buffer.from('hi')]), { statusCode: 600, statusMessage: 'Weird', headers: {} });
    fakeRequest.impl = (_url: unknown, _opts: unknown, onResponse: (r: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), { end: () => setImmediate(() => onResponse(res)) });
      return req;
    };
    await expect(createConnectorFetch(async () => ['198.252.206.16'])('https://sentry.example.com/api/0/')).rejects.toThrow(RangeError);
    expect(res.destroyed).toBe(true);
  });
});
