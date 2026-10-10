import { HttpException } from '@nestjs/common';
import { vi } from 'vitest';
import { envBlock, GithubAppSetupService } from './github-app-setup.service';

const admin = { id: 'u1', email: 'Ops@Example.com', emailVerified: true, isInteractive: true };

function setup(env: Record<string, string> = {}) {
  const values: Record<string, string> = { INSTANCE_ADMIN_EMAILS: 'ops@example.com', ...env };
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  };
  const service = new GithubAppSetupService({ get: (key: string) => values[key] } as never, redis as never);
  const fetchFn = vi.fn();
  service.fetchFn = fetchFn as never;
  return { service, redis, fetchFn };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as { code: string } };
  }
  throw new Error('expected rejection');
}

const conversion = {
  id: 4242,
  slug: 'dock-example',
  name: 'Dock dock.example.com',
  html_url: 'https://github.com/apps/dock-example',
  owner: { login: 'acme' },
  webhook_secret: 'whsec-123',
  client_id: 'Iv1.abc',
  client_secret: 'csecret',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----\n',
};

describe('GithubAppSetupService', () => {
  it('builds a private manifest from the public URLs with the run permissions', () => {
    const { service } = setup({ PUBLIC_API_URL: 'https://api.dock.example.com', PUBLIC_APP_URL: 'https://dock.example.com' });
    expect(service.manifest()).toEqual({
      name: 'Dock dock.example.com',
      url: 'https://dock.example.com',
      hook_attributes: { url: 'https://api.dock.example.com/v1/github/webhooks', active: true },
      redirect_url: 'https://dock.example.com/developers/github/setup',
      callback_urls: ['https://dock.example.com/developers/github/installed', 'https://dock.example.com'],
      request_oauth_on_install: true,
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', members: 'read' },
      default_events: ['issue_comment'],
    });
  });

  it('issues a caller-bound state and targets the user or organization form', async () => {
    const { service, redis } = setup();
    const personal = await service.start(admin);
    expect(personal.postUrl).toBe(`https://github.com/settings/apps/new?state=${personal.state}`);
    expect(JSON.parse(personal.manifest).hook_attributes.url).toBe('https://api.usedock.io/v1/github/webhooks');
    expect(redis.set).toHaveBeenCalledWith(`gh:manifest:${personal.state}`, 'u1', 'EX', 3600);
    const org = await service.start(admin, 'acme');
    expect(org.postUrl).toBe(`https://github.com/organizations/acme/settings/apps/new?state=${org.state}`);
  });

  it('is admin-only: needs INSTANCE_ADMIN_EMAILS, a listed email, and a browser session', async () => {
    expect((await rejection(setup({ INSTANCE_ADMIN_EMAILS: '' }).service.start(admin))).body.code).toBe('instance_admin_required');
    const { service, redis } = setup();
    expect((await rejection(service.start({ ...admin, email: 'other@example.com' }))).status).toBe(403);
    expect((await rejection(service.start({ ...admin, isInteractive: false }))).status).toBe(403);
    expect((await rejection(service.convert({ ...admin, email: 'x@y.z' }, 'code', 'a'.repeat(32)))).status).toBe(403);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('tells a listed admin with an unverified email to verify it', async () => {
    const { service } = setup();
    const err = await rejection(service.start({ ...admin, emailVerified: false }));
    expect(err.status).toBe(403);
    expect(JSON.stringify(err.body)).toContain('Verify your email');
  });

  it('exchanges the code once and returns env-ready credentials', async () => {
    const { service, fetchFn } = setup();
    const { state } = await service.start(admin);
    fetchFn.mockResolvedValue({ ok: true, status: 201, json: async () => conversion });
    const out = await service.convert(admin, 'abc123', state);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/app-manifests/abc123/conversions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(out).toMatchObject({
      appId: 4242,
      slug: 'dock-example',
      owner: 'acme',
      installUrl: 'https://github.com/apps/dock-example/installations/new',
      env: { GITHUB_APP_ID: '4242', GITHUB_APP_SLUG: 'dock-example', GITHUB_APP_WEBHOOK_SECRET: 'whsec-123', GITHUB_APP_PRIVATE_KEY: conversion.pem, GITHUB_APP_CLIENT_ID: 'Iv1.abc', GITHUB_APP_CLIENT_SECRET: 'csecret' },
    });
    expect(out.envFile).toContain('GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nAAA\\n');
    expect((await rejection(service.convert(admin, 'abc123', state))).body.code).toBe('invalid_state');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects another user state and maps GitHub failures', async () => {
    const { service, fetchFn } = setup({ INSTANCE_ADMIN_EMAILS: 'ops@example.com,second@example.com' });
    const { state } = await service.start(admin);
    const second = { ...admin, id: 'u2', email: 'second@example.com' };
    expect((await rejection(service.convert(second, 'c', state))).body.code).toBe('invalid_state');

    const fresh = await service.start(admin);
    fetchFn.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect((await rejection(service.convert(admin, 'stale', fresh.state))).body.code).toBe('invalid_code');

    const down = await service.start(admin);
    fetchFn.mockRejectedValue(new Error('ECONNRESET'));
    expect(await rejection(service.convert(admin, 'c', down.state))).toMatchObject({ status: 502, body: { code: 'github_unavailable' } });
  });

  it('escapes newlines and quotes in env lines', () => {
    expect(envBlock({ A: 'x\ny"z' })).toBe('A="x\\ny\\"z"');
  });
});
