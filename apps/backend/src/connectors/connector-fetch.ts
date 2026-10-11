import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { DeniedAddressError, defaultResolveHost, isDeniedAddress, pinnedLookup, type HostResolver } from '../webhooks/ssrf-guard';

/** Fixed vendor hosts; they keep the runtime's own fetch. Anything else is a self-hosted Sentry origin. */
const VENDOR_HOSTS = new Set([
  'api.figma.com',
  'www.figma.com',
  'api.linear.app',
  'linear.app',
  'mcp.linear.app',
  'slack.com',
  'sentry.io',
  'de.sentry.io',
  'us.sentry.io',
  'mcp.sentry.dev',
]);

type FetchFn = typeof fetch;

/**
 * Fetch for connector vendor calls. Self-hosted hosts go over node:https with a lookup that vets the
 * address at dial time, so the address checked is the address connected (Bun's fetch ignores a custom
 * agent, and a separate DNS check would leave a rebinding window). Redirects are never followed.
 */
export function createConnectorFetch(resolveHost: HostResolver = defaultResolveHost, base: FetchFn = fetch): FetchFn {
  return ((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (VENDOR_HOSTS.has(url.hostname.toLowerCase())) return base(input as never, init);
    return pinnedFetch(url, init, resolveHost);
  }) as FetchFn;
}

function pinnedFetch(url: URL, init: RequestInit, resolveHost: HostResolver): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'https:') return reject(new Error('Connector calls must use https'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Literal IPs skip lookup entirely, so vet them before any socket is opened.
    if (isIP(host) && isDeniedAddress(host)) return reject(new DeniedAddressError());
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    if (body) headers['content-length'] = String(body.length);
    const req = request(
      url,
      { method: init.method ?? 'GET', headers, lookup: pinnedLookup(resolveHost) as never, agent: false, signal },
      (res) => {
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) out.append(name, v);
        }
        const status = res.statusCode ?? 0;
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: out }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
