import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DockletClient, type DockletTransport } from './docklet.client';

const config = (overrides: Record<string, string> = {}) =>
  ({
    get: (key: string) => ({ DOCKLET_BASE_URL: 'http://docklet:8081', ...overrides })[key],
  }) as unknown as ConfigService;

const okTransport = (
  data: unknown,
  seen: { method?: string; url?: string; headers?: Record<string, string>; body?: string },
): DockletTransport =>
  async (method, url, headers, body) => {
    seen.method = method;
    seen.url = url;
    seen.headers = headers;
    seen.body = body;
    return { status: 200, text: JSON.stringify({ ok: true, data }) };
  };

describe('DockletClient', () => {
  it('posts the op with an idempotency token and returns data', async () => {
    const seen: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {};
    const client = new DockletClient(config(), okTransport({ ip: '10.1.2.3', hostId: 'h1' }, seen));
    await expect(client.provision({ dockId: 'd1', resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, image: 'ubuntu-24.04', idempotencyToken: 'tok-1' })).resolves.toEqual({
      ip: '10.1.2.3',
      hostId: 'h1',
    });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('http://docklet:8081/v1/provision');
    expect(seen.headers?.['idempotency-token']).toBeTruthy();
    expect(JSON.parse(seen.body as string)).toEqual({ dockId: 'd1', resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, image: 'ubuntu-24.04', idempotencyToken: 'tok-1' });
  });

  it('posts Fast Run lifecycle operations with caller idempotency tokens', async () => {
    const seen: string[] = [];
    const transport: DockletTransport = async (_method, url, _headers, body) => {
      seen.push(`${url}:${body}`);
      if (url.endsWith('/create')) {
        return {
          status: 200,
          text: JSON.stringify({
            ok: true,
            data: { runtimeId: 'fast-1', ip: '10.0.0.9', hostId: 'h1', capabilities: { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: {} } },
          }),
        };
      }
      if (url.endsWith('/exec')) {
        return { status: 200, text: JSON.stringify({ ok: true, data: { runtimeId: 'fast-1', exitCode: 0, stdout: 'ok', stderr: '' } }) };
      }
      if (url.endsWith('/read')) {
        return { status: 200, text: JSON.stringify({ ok: true, data: { runtimeId: 'fast-1', path: '/run/dock-fast/RESULT.json', content: '{}', sizeBytes: 2 } }) };
      }
      return { status: 200, text: JSON.stringify({ ok: true, data: { runtimeId: 'fast-1' } }) };
    };
    const client = new DockletClient(config(), transport);
    await expect(
      client.fastRunCreate({
        runtimeId: 'fast-1',
        resources: { cpus: 2, memoryMiB: 4096, diskGiB: 20 },
        image: 'ubuntu-24.04',
        capabilities: { version: 1, target: 'fast', profile: 'warm-microvm', capabilities: {} },
        guestToken: 'guest-token',
        idempotencyToken: 'create-1',
      }),
    ).resolves.toMatchObject({ runtimeId: 'fast-1' });
    await expect(client.fastRunExec({ runtimeId: 'fast-1', script: 'echo ok', timeoutSeconds: 30, idempotencyToken: 'exec-1' })).resolves.toMatchObject({ exitCode: 0 });
    await expect(client.fastRunRead({ runtimeId: 'fast-1', path: '/run/dock-fast/RESULT.json', idempotencyToken: 'read-1' })).resolves.toMatchObject({ sizeBytes: 2 });
    await expect(client.fastRunTerminate('fast-1', 'term-1')).resolves.toEqual({ runtimeId: 'fast-1' });
    expect(seen).toHaveLength(4);
    expect(seen[0]).toContain('create-1');
    expect(seen[1]).toContain('exec-1');
    expect(seen[2]).toContain('read-1');
    expect(seen[3]).toContain('term-1');
  });

  it('sends the configured local token as a bearer header on posts and gets', async () => {
    const seen: { headers?: Record<string, string> } = {};
    const client = new DockletClient(config({ DOCKLET_LOCAL_TOKEN: 'local-secret' }), okTransport({ hostId: 'h1', running: [] }, seen));
    await client.fastRunTerminate('r1', 'tok');
    expect(seen.headers?.authorization).toBe('Bearer local-secret');
    seen.headers = undefined;
    await client.status();
    expect(seen.headers?.authorization).toBe('Bearer local-secret');
  });

  it('omits the authorization header when no local token is configured', async () => {
    const seen: { headers?: Record<string, string> } = {};
    const client = new DockletClient(config(), okTransport({}, seen));
    await client.fastRunTerminate('r1', 'tok');
    expect(seen.headers?.authorization).toBeUndefined();
  });

  it('throws the docklet code on failure envelopes', async () => {
    const client = new DockletClient(
      config(),
      async () => ({ status: 409, text: JSON.stringify({ ok: false, code: 'snapshot_in_use', message: 'busy' }) }),
    );
    const err = await client.destroy('d1').catch((e) => e);
    expect(err).toMatchObject({ code: 'snapshot_in_use', message: 'busy' });
  });

  it('throws docklet_unreachable on unreadable responses', async () => {
    const client = new DockletClient(config(), async () => ({ status: 502, text: 'not json' }));
    await expect(client.pause('d1')).rejects.toMatchObject({ code: 'docklet_unreachable' });
  });

  it('fetches host status inventory', async () => {
    const seen: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {};
    const client = new DockletClient(
      config(),
      okTransport({ hostId: 'h1', running: [{ dockId: 'd1', state: 'running' }] }, seen),
    );
    await expect(client.status()).resolves.toEqual({ hostId: 'h1', running: [{ dockId: 'd1', state: 'running' }] });
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('http://docklet:8081/v1/status');
  });

  it('fetches a host-truth sample for one dock', async () => {
    const seen: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {};
    const sample = { dockId: 'd1', cpuPercent: 12.5, memBytes: 99, memLimit: 100, diskBytes: 1, rxBytes: 2, txBytes: 3 };
    const client = new DockletClient(config(), okTransport(sample, seen));
    await expect(client.sample('d1')).resolves.toEqual(sample);
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('http://docklet:8081/v1/stats?dock=d1');
  });

  it('sends the caller token for snapshot captures', async () => {
    const seen: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {};
    const client = new DockletClient(
      config(),
      okTransport({ snapshotId: 's1', sizeBytes: 1, cpuFamily: 'fam' }, seen),
    );
    await client.snapshotCreate('d1', null, 'full', false, false, 'final:d1:root');
    expect(JSON.parse(seen.body as string)).toMatchObject({ dockId: 'd1', idempotencyToken: 'final:d1:root' });
  });

  it('builds an mTLS agent only when all three paths are set', async () => {
    const plain = new DockletClient(config());
    expect((plain as unknown as { agent?: unknown }).agent).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'docklet-'));
    const paths = { DOCKLET_CA_PATH: join(dir, 'ca'), DOCKLET_CERT_PATH: join(dir, 'cert'), DOCKLET_KEY_PATH: join(dir, 'key') };
    for (const file of Object.values(paths)) writeFileSync(file, 'dummy-pem');
    const mtls = new DockletClient(config({ DOCKLET_BASE_URL: 'https://docklet:8081', ...paths }));
    expect((mtls as unknown as { agent?: unknown }).agent).toBeDefined();
  });
});
