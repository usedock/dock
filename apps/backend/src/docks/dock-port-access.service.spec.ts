import { vi } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { DockPortAccessService, PORT_AUTH_PATH, safePath } from './dock-port-access.service';
import { DockPortsService } from './dock-ports.service';
import { edgeProof, signPortToken, SESSION_TTL_SECONDS } from './port-access-token';

const dockId = '33333333-3333-4333-8333-333333333333';
const otherDockId = '44444444-4444-4444-8444-444444444444';
const label = '3000-abcdefghijkmnpqr';
const host = `${label}.ports.x.dev`;
const config = {
  BETTER_AUTH_SECRET: 'test-secret',
  PORTS_DOMAIN: 'ports.x.dev',
  PORTS_PROXY_PORT: 8001,
  PUBLIC_API_URL: 'https://dock.x.dev',
  PUBLIC_APP_URL: 'https://dock.x.dev',
};
const reader = { get: (key: string) => (config as Record<string, unknown>)[key] };

/** Drizzle stand-in: every awaited query chain yields the next queued result. */
function fakeDb(results: unknown[][]) {
  const chain = (): any =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return (resolve: (v: unknown) => void) => Promise.resolve(results.shift() ?? []).then(resolve);
          return () => chain();
        },
      },
    );
  return chain();
}

const portRow = (visibility: 'public' | 'private') => ({ dockId, visibility });
const keyRow = (overrides: Record<string, unknown> = {}) => ({ userId: 'u1', keyHash: hashToken('dock_abc'), dockId, revokedAt: null, expiresAt: null, ...overrides });

describe('DockPortAccessService', () => {
  let docks: { loadDock: ReturnType<typeof vi.fn> };
  let betterAuth: { getSessionUser: ReturnType<typeof vi.fn> };
  let closures: { guardCheck: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    closures = { guardCheck: vi.fn().mockResolvedValue('ok') };
    docks = { loadDock: vi.fn().mockResolvedValue({ dock: { id: dockId }, orgId: 'o1' }) };
    betterAuth = { getSessionUser: vi.fn().mockResolvedValue({ id: 'u1' }) };
  });

  function service(results: unknown[][]) {
    const ports = new DockPortsService(fakeDb([]), {} as never, {} as never, reader as never);
    return new DockPortAccessService(fakeDb(results), docks as never, ports, betterAuth as never, reader as never, closures as never);
  }

  const proof = edgeProof(reader, label);
  const session = (userId = 'u1', ttl = SESSION_TTL_SECONDS, now = Date.now()) => `dock_port_access=${signPortToken(reader, 'session', label, userId, ttl, now)}`;

  it('lets a public port through without a credential and without the edge proof', async () => {
    await expect(service([[portRow('public')]]).authorize({ host, uri: '/', wantsHtml: false })).resolves.toEqual({ status: 200, headers: {} });
  });

  it('answers 404 for unknown and non-port hostnames', async () => {
    await expect(service([[]]).authorize({ host, wantsHtml: false })).resolves.toEqual({ status: 404 });
    await expect(service([]).authorize({ host: 'dock.x.dev', wantsHtml: false })).resolves.toEqual({ status: 404 });
    await expect(service([]).authorize({ wantsHtml: false })).resolves.toEqual({ status: 404 });
  });

  it('lets an org member through with the port cookie', async () => {
    const result = await service([[portRow('private')]]).authorize({ host, uri: '/', cookie: `a=b; ${session()}`, wantsHtml: false });
    expect(result).toEqual({ status: 200, headers: { 'X-Dock-Port-Auth': proof } });
    expect(docks.loadDock).toHaveBeenCalledWith('u1', dockId);
  });

  it('refuses a cookie whose user is no longer a member', async () => {
    docks.loadDock.mockRejectedValue(new Error('not found'));
    await expect(service([[portRow('private')]]).authorize({ host, cookie: session(), wantsHtml: false })).resolves.toEqual({ status: 401 });
  });

  it('refuses a cookie, an exchange and the landing for a closed account', async () => {
    closures.guardCheck.mockResolvedValue('closed');
    await expect(service([[portRow('private')]]).authorize({ host, cookie: session(), wantsHtml: false })).resolves.toEqual({ status: 401 });
    const token = signPortToken(reader, 'exchange', label, 'u1', 60);
    await expect(service([[portRow('private')]]).authorize({ host, uri: `${PORT_AUTH_PATH}?token=${token}`, wantsHtml: true })).resolves.toEqual({ status: 401 });
    await expect(service([[portRow('private')]]).access(host, '/', 'cookie')).resolves.toEqual({ status: 404 });
    expect(closures.guardCheck).toHaveBeenCalledWith('u1');
    expect(docks.loadDock).not.toHaveBeenCalled();
  });

  it('refuses an expired cookie, a cookie for another port, and a forged one', async () => {
    const expired = session('u1', 60, Date.now() - 3600_000);
    await expect(service([[portRow('private')]]).authorize({ host, cookie: expired, wantsHtml: false })).resolves.toEqual({ status: 401 });
    const other = `dock_port_access=${signPortToken(reader, 'session', '8080-zzzzzzzzzzzzzzzz', 'u1', 600)}`;
    await expect(service([[portRow('private')]]).authorize({ host, cookie: other, wantsHtml: false })).resolves.toEqual({ status: 401 });
    const forged = session().slice(0, -3) + 'abc';
    await expect(service([[portRow('private')]]).authorize({ host, cookie: forged, wantsHtml: false })).resolves.toEqual({ status: 401 });
  });

  it('does not accept an exchange token as a session cookie', async () => {
    const exchange = `dock_port_access=${signPortToken(reader, 'exchange', label, 'u1', 60)}`;
    await expect(service([[portRow('private')]]).authorize({ host, cookie: exchange, wantsHtml: false })).resolves.toEqual({ status: 401 });
  });

  it('lets a key bound to this dock through as a bearer token', async () => {
    const result = await service([[portRow('private')], [keyRow()]]).authorize({ host, authorization: 'Bearer dock_abc', wantsHtml: false });
    expect(result).toEqual({ status: 200, headers: { 'X-Dock-Port-Auth': proof } });
    expect(docks.loadDock).toHaveBeenCalledWith('u1', dockId);
  });

  it('refuses a dock-bound key whose owner left the organization', async () => {
    docks.loadDock.mockRejectedValue(new Error('not found'));
    await expect(service([[portRow('private')], [keyRow()]]).authorize({ host, authorization: 'Bearer dock_abc', wantsHtml: false })).resolves.toEqual({ status: 401 });
  });

  it('refuses keys bound to another dock, unbound, revoked, or expired', async () => {
    for (const row of [keyRow({ dockId: otherDockId }), keyRow({ dockId: null }), keyRow({ revokedAt: new Date() }), keyRow({ expiresAt: new Date(Date.now() - 1000) })]) {
      await expect(service([[portRow('private')], [row]]).authorize({ host, authorization: 'Bearer dock_abc', wantsHtml: false })).resolves.toEqual({ status: 401 });
    }
    await expect(service([[portRow('private')], []]).authorize({ host, authorization: 'Bearer dock_abc', wantsHtml: false })).resolves.toEqual({ status: 401 });
    await expect(service([[portRow('private')]]).authorize({ host, authorization: 'Bearer not-a-dock-key', wantsHtml: false })).resolves.toEqual({ status: 401 });
  });

  it('falls back to the cookie when the app sends its own bearer token', async () => {
    const result = await service([[portRow('private')]]).authorize({ host, cookie: session(), authorization: 'Bearer app-token', wantsHtml: true });
    expect(result.status).toBe(200);
  });

  it('sends a browser without credentials to the control plane, and an API client a 401', async () => {
    const browser = await service([[portRow('private')]]).authorize({ host, uri: '/app?x=1', wantsHtml: true });
    expect(browser).toEqual({
      status: 302,
      location: `https://dock.x.dev/v1/ports/access?host=${encodeURIComponent(host)}&next=${encodeURIComponent('/app?x=1')}`,
    });
    await expect(service([[portRow('private')]]).authorize({ host, uri: '/', wantsHtml: false })).resolves.toEqual({ status: 401 });
  });

  describe('access landing', () => {
    it('sends a signed-in member to the port host with an exchange token', async () => {
      const result = await service([[portRow('private')]]).access(host, '/app?x=1', 'cookie');
      expect(result.status).toBe(302);
      const location = new URL((result as { location: string }).location);
      expect(location.origin).toBe(`https://${host}`);
      expect(location.pathname).toBe(PORT_AUTH_PATH);
      expect(location.searchParams.get('next')).toBe('/app?x=1');
      expect(location.searchParams.get('token')).toBeTruthy();
    });

    it('sends a signed-out browser to the dashboard login and returns here afterwards', async () => {
      betterAuth.getSessionUser.mockResolvedValue(null);
      const result = (await service([[portRow('private')]]).access(host, '/', undefined)) as { location: string };
      expect(result.location.startsWith('https://dock.x.dev/auth/login?next=')).toBe(true);
      expect(decodeURIComponent(result.location.split('next=')[1])).toContain('/v1/ports/access?host=');
    });

    it('hides ports from non-members and refuses public or unknown ports', async () => {
      docks.loadDock.mockRejectedValue(new Error('not found'));
      await expect(service([[portRow('private')]]).access(host, '/', 'cookie')).resolves.toEqual({ status: 404 });
      await expect(service([[portRow('public')]]).access(host, '/', 'cookie')).resolves.toEqual({ status: 404 });
      await expect(service([[]]).access(host, '/', 'cookie')).resolves.toEqual({ status: 404 });
      await expect(service([]).access('evil.example.com', '/', 'cookie')).resolves.toEqual({ status: 404 });
    });

    it('never redirects off the port host', async () => {
      const result = (await service([[portRow('private')]]).access(host, '//evil.example.com', 'cookie')) as { location: string };
      expect(new URL(result.location).searchParams.get('next')).toBe('/');
      expect(new URL(result.location).host).toBe(host);
    });
  });

  describe('exchange', () => {
    const exchangeUri = (token: string, next = '/ok') => `${PORT_AUTH_PATH}?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;

    it('trades a valid exchange token for a host-only cookie and redirects to next', async () => {
      const token = signPortToken(reader, 'exchange', label, 'u1', 60);
      const result = await service([[portRow('private')]]).authorize({ host, uri: exchangeUri(token), wantsHtml: true });
      expect(result).toMatchObject({ status: 302, location: '/ok' });
      const cookie = (result as { setCookie: string }).setCookie;
      expect(cookie).toMatch(/^dock_port_access=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
      expect(cookie).not.toMatch(/Domain=/);
    });

    it('refuses an expired token, a token for another port, a session token, and a non-member', async () => {
      const expired = signPortToken(reader, 'exchange', label, 'u1', 60, Date.now() - 3600_000);
      const other = signPortToken(reader, 'exchange', '8080-zzzzzzzzzzzzzzzz', 'u1', 60);
      const wrongKind = signPortToken(reader, 'session', label, 'u1', 60);
      for (const token of [expired, other, wrongKind, 'garbage']) {
        await expect(service([[portRow('private')]]).authorize({ host, uri: exchangeUri(token), wantsHtml: true })).resolves.toEqual({ status: 401 });
      }
      docks.loadDock.mockRejectedValue(new Error('not found'));
      const valid = signPortToken(reader, 'exchange', label, 'u1', 60);
      await expect(service([[portRow('private')]]).authorize({ host, uri: exchangeUri(valid), wantsHtml: true })).resolves.toEqual({ status: 401 });
    });
  });
});

describe('safePath', () => {
  it('keeps same-origin paths and rejects everything else', () => {
    expect(safePath('/a/b?c=1')).toBe('/a/b?c=1');
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', '', undefined]) {
      expect(safePath(bad as string | undefined)).toBe('/');
    }
  });
});
