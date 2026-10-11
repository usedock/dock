import { HttpException } from '@nestjs/common';
import { HostsService } from './hosts.service';
import { vi } from 'vitest';
import { hashCredential } from '../fleet/host-command-queue';
import { hosts } from '../database/schema';

describe('HostsService', () => {
  let db: any;
  let service: HostsService;

  const hostRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'h1',
    address: '10.0.0.1:8081',
    cpuFamily: 'x86_64-v4',
    kernel: '6.8.0',
    runtime: 'microvm',
    kernelRelease: null,
    vcpuTotal: 0,
    memTotalBytes: 0,
    maxDocks: 8,
    usedDocks: 0,
    state: 'online',
    lastHeartbeatAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  });

  const selectQ = (rows: any[]) => {
    const p = Promise.resolve(rows);
    const where = () => ({ limit: () => p, then: p.then.bind(p) });
    return { from: () => ({ where }) };
  };
  const insertQ = (rows: any[]) => ({
    values: () => ({ returning: () => Promise.resolve(rows) }),
  });
  const updateQ = (rows: any[], seen?: { set?: unknown }) => ({
    set: (values: unknown) => {
      if (seen) seen.set = values;
      return { where: () => ({ returning: () => Promise.resolve(rows) }) };
    },
  });

  async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected rejection');
  }

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    vi.clearAllMocks();
    service = new HostsService(db as never, { get: (key: string) => (key === 'INSTANCE_ADMIN_EMAILS' ? 'ops@example.com' : undefined) } as never);
  });

  it('issues a credential and stores only its hash', async () => {
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([{ id: 'h1' }], seen));
    const credential = await service.issueCredential('h1');
    expect(credential).toMatch(/^hc_[A-Za-z0-9_-]{43}$/);
    expect(seen.set.credentialHash).toBe(hashCredential(credential));
    expect(JSON.stringify(seen.set)).not.toContain(credential);
  });

  it('refuses to issue a credential for an unknown host', async () => {
    db.update.mockReturnValueOnce(updateQ([]));
    db.select.mockReturnValueOnce(selectQ([]));
    const err = await catchErr(service.issueCredential('nope'));
    expect(err.status).toBe(404);
  });

  it('never replaces an existing credential: 409 host_already_enrolled', async () => {
    db.update.mockReturnValueOnce(updateQ([]));
    db.select.mockReturnValueOnce(selectQ([hostRow({ credentialHash: 'abc' })]));
    const err = await catchErr(service.issueCredential('h1'));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'host_already_enrolled' });
  });

  describe('registerUnenrolled', () => {
    const input = { hostId: 'h1', address: 'outbound', cpuFamily: 'x86_64-v4', kernel: '6.8.0', maxDocks: 8 };
    const insertWith = (rows: any[]) => ({ values: vi.fn(() => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }) })) });

    it('creates a new host with the credential hash in the same write', async () => {
      const ins = insertWith([{ id: 'h1' }]);
      db.insert.mockReturnValueOnce(ins);
      const credential = await service.registerUnenrolled(input, true);
      expect(ins.values).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1', credentialHash: hashCredential(credential as string) }));
    });

    it('stores the guest memory budget the host registers', async () => {
      const ins = insertWith([{ id: 'h1' }]);
      db.insert.mockReturnValueOnce(ins);
      await service.registerUnenrolled({ ...input, memBudgetBytes: 6 * 1024 ** 3 }, false);
      expect(ins.values).toHaveBeenCalledWith(expect.objectContaining({ memBudgetBytes: 6 * 1024 ** 3 }));
    });

    it('stores the features the host registers and an empty list when it sends none', async () => {
      const first = insertWith([{ id: 'h1' }]);
      db.insert.mockReturnValueOnce(first);
      await service.registerUnenrolled({ ...input, features: ['egress-on-resume'] }, false);
      expect(first.values).toHaveBeenCalledWith(expect.objectContaining({ features: ['egress-on-resume'] }));
      const second = insertWith([{ id: 'h1' }]);
      db.insert.mockReturnValueOnce(second);
      await service.registerUnenrolled(input, false);
      expect(second.values).toHaveBeenCalledWith(expect.objectContaining({ features: [] }));
    });

    it('claims and updates a credential-less host in one conditional update', async () => {
      db.insert.mockReturnValueOnce(insertWith([]));
      const seen: { set?: any } = {};
      db.update.mockReturnValueOnce(updateQ([{ id: 'h1' }], seen));
      const credential = await service.registerUnenrolled({ ...input, maxDocks: 4 }, true);
      expect(seen.set.maxDocks).toBe(4);
      expect(seen.set.credentialHash).toBe(hashCredential(credential as string));
    });

    it('registers without issuing when the docklet does not accept a credential', async () => {
      db.insert.mockReturnValueOnce(insertWith([]));
      const seen: { set?: any } = {};
      db.update.mockReturnValueOnce(updateQ([{ id: 'h1' }], seen));
      await expect(service.registerUnenrolled(input, false)).resolves.toBeUndefined();
      expect(seen.set).not.toHaveProperty('credentialHash');
    });

    it('409s an enrolled host from the conditional update, so no field is overwritten', async () => {
      db.insert.mockReturnValueOnce(insertWith([]));
      db.update.mockReturnValueOnce(updateQ([]));
      const err = await catchErr(service.registerUnenrolled(input, true));
      expect(err.status).toBe(409);
      expect(err.body).toMatchObject({ code: 'host_already_enrolled' });
    });
  });

  it('enrolls a new host as an offline placeholder and claims its credential', async () => {
    const values = vi.fn(() => ({ onConflictDoNothing: () => Promise.resolve([]) }));
    db.insert.mockReturnValueOnce({ values });
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([{ id: 'h9' }], seen));
    const credential = await service.enrollHost('h9', 'gvisor');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: 'h9', state: 'offline', maxDocks: 0, runtime: 'gvisor' }));
    expect(seen.set.credentialHash).toBe(hashCredential(credential));
  });

  it('lets only instance admins reset a credential, and replaces it unconditionally', async () => {
    db.update.mockClear();
    expect((await catchErr(service.resetCredential({ email: 'member@example.com', emailVerified: true }, 'h1'))).status).toBe(403);
    expect((await catchErr(service.resetCredential({ email: 'ops@example.com', emailVerified: false }, 'h1'))).status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([{ id: 'h1' }], seen));
    const reset = await service.resetCredential({ email: 'ops@example.com', emailVerified: true }, 'h1');
    expect(reset.credential).toMatch(/^hc_/);
    expect(seen.set.credentialHash).toBe(hashCredential(reset.credential));
    db.update.mockReturnValueOnce(updateQ([]));
    expect((await catchErr(service.resetCredential({ email: 'ops@example.com', emailVerified: true }, 'nope'))).status).toBe(404);
  });

  it('never exposes the credential hash in admin views', async () => {
    db.select.mockReturnValueOnce({ from: () => ({ orderBy: () => Promise.resolve([hostRow({ credentialHash: 'secret-hash', running: [] })]) }) });
    const [summary] = await service.listForAdmin({ email: 'ops@example.com', emailVerified: true });
    expect(JSON.stringify(summary)).not.toContain('secret-hash');
  });

  it('keeps only dock ids placed on the host and drops non-uuid ids', async () => {
    const own = '11111111-1111-4111-8111-111111111111';
    db.select.mockReturnValueOnce(selectQ([{ id: own }]));
    const result = await service.dockIdsOnHost('h1', [own, '22222222-2222-4222-8222-222222222222', 'not-a-uuid']);
    expect([...result]).toEqual([own]);
    db.select.mockClear();
    expect((await service.dockIdsOnHost('h1', ['nope'])).size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('registers a new host as online', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([hostRow()]));
    const host = await service.register({ hostId: 'h1', address: '10.0.0.1:8081', cpuFamily: 'x86_64-v4', kernel: '6.8.0', maxDocks: 8 });
    expect(host).toMatchObject({ id: 'h1', state: 'online', usedDocks: 0 });
    expect(db.insert).toHaveBeenCalled();
  });

  it('re-registers caps without flipping state', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ state: 'offline', address: 'old:8081', maxDocks: 4 })]));
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([hostRow({ state: 'offline', address: 'new:8081', maxDocks: 16 })], seen));
    const host = await service.register({ hostId: 'h1', address: 'new:8081', cpuFamily: 'x86_64-v4', kernel: '6.9.0', maxDocks: 16 });
    expect(host).toMatchObject({ state: 'offline', address: 'new:8081', maxDocks: 16 });
    expect(seen.set).not.toMatchObject({ state: 'online' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('heartbeats usedDocks and flips offline back online', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ state: 'offline', usedDocks: 0 })]));
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([hostRow({ state: 'online', usedDocks: 3 })], seen));
    const host = await service.heartbeat('h1', { usedDocks: 3, running: [] });
    expect(host).toMatchObject({ state: 'online', usedDocks: 3 });
    expect(seen.set.state).toBe('online');
    expect(seen.set.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('derives usedDocks from running inventory when omitted', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ usedDocks: 0 })]));
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([hostRow({ usedDocks: 2 })], seen));
    await service.heartbeat('h1', { running: [{ dockId: 'd1', state: 'running' }, { dockId: 'd2', state: 'running' }] });
    expect(seen.set.usedDocks).toBe(2);
  });

  it('stores reported base fingerprints and keeps them when a heartbeat omits them', async () => {
    const fp = 'a'.repeat(64);
    db.select.mockReturnValueOnce(selectQ([hostRow()]));
    const reported: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([hostRow({ baseFingerprints: [fp] })], reported));
    await service.heartbeat('h1', { running: [], baseFingerprints: [fp] });
    expect(reported.set.baseFingerprints).toEqual([fp]);

    db.select.mockReturnValueOnce(selectQ([hostRow({ baseFingerprints: [fp] })]));
    const omitted: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([hostRow({ baseFingerprints: [fp] })], omitted));
    await service.heartbeat('h1', { running: [] });
    expect(omitted.set).not.toHaveProperty('baseFingerprints');
  });

  it('rejects heartbeats from unknown hosts', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const err = await catchErr(service.heartbeat('ghost', { usedDocks: 0 }));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'host_not_found' });
  });

  it('sweeps only stale hosts offline', async () => {
    const now = new Date('2026-09-07T00:01:31Z');
    const stale = hostRow({ id: 'stale', lastHeartbeatAt: new Date('2026-09-07T00:00:00Z') });
    const fresh = hostRow({ id: 'fresh', lastHeartbeatAt: new Date('2026-09-07T00:01:20Z') });
    db.select.mockReturnValueOnce(selectQ([stale, fresh]));
    db.update.mockReturnValueOnce(updateQ([{ ...stale, state: 'offline' }]));
    const marked = await service.sweepOffline(now);
    expect(marked.map((h) => h.id)).toEqual(['stale']);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('treats never-heartbeated hosts as stale by creation time', async () => {
    const now = new Date('2026-09-07T00:01:31Z');
    const silent = hostRow({ id: 'silent', lastHeartbeatAt: null, createdAt: new Date('2026-09-07T00:00:00Z') });
    db.select.mockReturnValueOnce(selectQ([silent]));
    db.update.mockReturnValueOnce(updateQ([{ ...silent, state: 'offline' }]));
    const marked = await service.sweepOffline(now);
    expect(marked.map((h) => h.id)).toEqual(['silent']);
  });

  it('lists offline hosts for the dock sweep', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ id: 'gone', state: 'offline' })]));
    expect((await service.listOffline()).map((x) => x.id)).toEqual(['gone']);
  });

  /** Row-locking fake: transactions run one at a time, like FOR UPDATE on the host rows. */
  function useTx(hostRows: any[], dockRows: any[] = [], placed: { cpus: number; memoryMiB: number } = { cpus: 2, memoryMiB: 4096 }) {
    let chain: Promise<unknown> = Promise.resolve();
    const holding = (d: any) => d.hostId && !['archived', 'error'].includes(d.state);
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = table === hosts ? hostRows : dockRows.filter(holding);
            const p = Promise.resolve(rows);
            return { orderBy: () => ({ for: () => p }), for: () => p, then: p.then.bind(p) };
          },
        }),
      }),
      update: () => ({
        set: (values: any) => ({
          where: async () => {
            await new Promise((r) => setTimeout(r, 1));
            dockRows.push({ id: `placed-${dockRows.length}`, state: 'provisioning', ...placed, ...values });
          },
        }),
      }),
    };
    db.transaction = vi.fn((fn: any) => {
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    });
    return dockRows;
  }

  it('places on the same-family host with most headroom', async () => {
    useTx([
        hostRow({ id: 'roomy', usedDocks: 2, maxDocks: 8 }),
        hostRow({ id: 'tight', usedDocks: 7, maxDocks: 8 }),
        hostRow({ id: 'full', usedDocks: 4, maxDocks: 4 }),
        hostRow({ id: 'arm', cpuFamily: 'aarch64', usedDocks: 0, maxDocks: 8 }),
      ]);
    const host = await service.placeForDock({ cpuFamily: 'x86_64-v4' });
    expect(host?.id).toBe('roomy');
  });

  describe('placement that needs a host feature', () => {
    it('places only on hosts that registered it', async () => {
      useTx([hostRow({ id: 'old', usedDocks: 0, features: [] }), hostRow({ id: 'new', usedDocks: 6, features: ['egress-on-resume'] })]);
      await expect(service.placeForDock({ cpuFamily: 'x86_64-v4', feature: 'egress-on-resume' })).resolves.toMatchObject({ id: 'new' });
    });

    it('finds no host when none has it, and ignores features when not required', async () => {
      useTx([hostRow({ id: 'old', features: [] })]);
      await expect(service.placeForDock({ cpuFamily: 'x86_64-v4', feature: 'egress-on-resume' })).resolves.toBeNull();
      useTx([hostRow({ id: 'old', features: [] })]);
      await expect(service.placeForDock({ cpuFamily: 'x86_64-v4' })).resolves.toMatchObject({ id: 'old' });
    });
  });

  describe('placement for a delta generation', () => {
    const base = 'b'.repeat(64);
    const other = 'c'.repeat(64);

    it('requires a host holding the base, even over roomier ones', async () => {
      useTx([
        hostRow({ id: 'roomy', usedDocks: 0, baseFingerprints: [other] }),
        hostRow({ id: 'holder', usedDocks: 6, baseFingerprints: [other, base] }),
      ]);
      await expect(service.placeForDock({ cpuFamily: 'x86_64-v4', baseFingerprint: base })).resolves.toMatchObject({ id: 'holder' });
    });

    it('prefers reporting holders over hosts that never reported their bases', async () => {
      useTx([hostRow({ id: 'legacy', usedDocks: 0, baseFingerprints: null }), hostRow({ id: 'holder', usedDocks: 6, baseFingerprints: [base] })]);
      await expect(service.placeForDock({ baseFingerprint: base })).resolves.toMatchObject({ id: 'holder' });
    });

    it('falls back to hosts that never reported their bases', async () => {
      useTx([hostRow({ id: 'reported', baseFingerprints: [other] }), hostRow({ id: 'legacy', baseFingerprints: null })]);
      await expect(service.placeForDock({ baseFingerprint: base })).resolves.toMatchObject({ id: 'legacy' });
    });

    it('fails with base_image_unavailable when no eligible host holds the base', async () => {
      useTx([hostRow({ id: 'a', baseFingerprints: [other] }), hostRow({ id: 'b', baseFingerprints: [] })]);
      const err = await catchErr(service.placeForDock({ cpuFamily: 'x86_64-v4', baseFingerprint: base }));
      expect(err.status).toBe(503);
      expect(err.body).toMatchObject({ code: 'base_image_unavailable' });
    });

    it('ignores holders of another family or runtime', async () => {
      useTx([
        hostRow({ id: 'arm', cpuFamily: 'aarch64', baseFingerprints: [base] }),
        hostRow({ id: 'gv', runtime: 'gvisor', baseFingerprints: [base] }),
        hostRow({ id: 'mv', baseFingerprints: [] }),
      ]);
      const err = await catchErr(service.placeForDock({ cpuFamily: 'x86_64-v4', runtime: 'microvm', baseFingerprint: base }));
      expect(err.body).toMatchObject({ code: 'base_image_unavailable' });
    });

    it('reports capacity, not the base, when the only holder is full', async () => {
      useTx([hostRow({ id: 'holder', usedDocks: 8, maxDocks: 8, baseFingerprints: [base] }), hostRow({ id: 'free', baseFingerprints: [] })]);
      await expect(service.placeForDock({ baseFingerprint: base })).resolves.toBeNull();
    });

    it('places a generation without a base anywhere, as before', async () => {
      useTx([hostRow({ id: 'roomy', usedDocks: 0, baseFingerprints: [other] }), hostRow({ id: 'tight', usedDocks: 6, baseFingerprints: [base] })]);
      await expect(service.placeForDock({ baseFingerprint: null })).resolves.toMatchObject({ id: 'roomy' });
    });
  });

  it('refuses cross-family placement', async () => {
    useTx([hostRow({ cpuFamily: 'x86_64-v4' })]);
    await expect(service.placeForDock({ cpuFamily: 'aarch64' })).resolves.toBeNull();
  });

  it('excludes offline and full hosts from placement', async () => {
    useTx([
        hostRow({ id: 'down', state: 'offline', usedDocks: 0 }),
        hostRow({ id: 'full', usedDocks: 8, maxDocks: 8 }),
      ]);
    await expect(service.placeForDock({ cpuFamily: 'x86_64-v4' })).resolves.toBeNull();
  });
  it('places on the roomiest host when no family is required', async () => {
    useTx([
        hostRow({ id: 'tight', usedDocks: 7, maxDocks: 8 }),
        hostRow({ id: 'arm', cpuFamily: 'aarch64', usedDocks: 0, maxDocks: 8 }),
      ]);
    const host = await service.placeForDock({});
    expect(host?.id).toBe('arm');
  });

  it('defaults unregistered hosts to the microvm runtime', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([hostRow()]));
    const host = await service.register({ hostId: 'h1', address: '10.0.0.1:8081', cpuFamily: 'x86_64-v4', kernel: '6.8.0', maxDocks: 8 });
    expect(host).toMatchObject({ runtime: 'microvm' });
  });

  it('places across runtimes unless one is pinned', async () => {
    const gv = hostRow({ id: 'gv-1', runtime: 'gvisor', usedDocks: 0, maxDocks: 8 });
    const mv = hostRow({ id: 'mv-1', runtime: 'microvm', usedDocks: 4, maxDocks: 8 });
    useTx([gv, mv]);
    await expect(service.placeForDock({ cpuFamily: 'x86_64-v4' })).resolves.toMatchObject({ id: 'gv-1' });
    useTx([gv, mv]);
    await expect(service.placeForDock({ cpuFamily: 'x86_64-v4', runtime: 'microvm' })).resolves.toMatchObject({ id: 'mv-1' });
    useTx([gv]);
    await expect(service.placeForDock({ cpuFamily: 'x86_64-v4', runtime: 'microvm' })).resolves.toBeNull();
  });

  it('rejects unknown runtime registrations with validation_error', async () => {
    for (const runtime of ['pvm', 'docker', 'firecracker']) {
      const err = await catchErr(
        service.register({ hostId: 'h-x', address: '10.0.0.9:8081', cpuFamily: 'x86_64-v4', kernel: '6.8.0', runtime: runtime as never, maxDocks: 8 }),
      );
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: 'validation_error' });
    }
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('stores the runtime a host registers with and updates it from the heartbeat', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const values = vi.fn(() => ({ returning: () => Promise.resolve([hostRow({ runtime: 'gvisor' })]) }));
    db.insert.mockReturnValueOnce({ values });
    await service.register({ hostId: 'h1', address: 'outbound', cpuFamily: 'x86_64-v4', kernel: '6.8.0', runtime: 'gvisor', maxDocks: 8 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'gvisor' }));
    db.select.mockReturnValueOnce(selectQ([hostRow()]));
    const seen: { set?: any } = {};
    db.update.mockReturnValueOnce(updateQ([hostRow({ runtime: 'gvisor' })], seen));
    await service.heartbeat('h1', { runtime: 'gvisor' });
    expect(seen.set.runtime).toBe('gvisor');
  });

  it('weights capacity by each dock size so one 8 cpu dock fills an 8 vCPU host', async () => {
    const small = hostRow({ id: 'h1', vcpuTotal: 8, memTotalBytes: 16 * 1024 ** 3, maxDocks: 8 });
    useTx([small], [{ id: 'big', hostId: 'h1', cpus: 8, memoryMiB: 16384, state: 'ready' }]);
    await expect(service.placeForDock({ cpuFamily: 'x86_64-v4', dockId: 'new', cpus: 1, memoryMiB: 2048 })).resolves.toBeNull();
  });

  it('counts memory as well as cpus', async () => {
    const h = hostRow({ id: 'h1', vcpuTotal: 64, memTotalBytes: 8 * 1024 ** 3, maxDocks: 32 });
    useTx([h], [{ id: 'a', hostId: 'h1', cpus: 4, memoryMiB: 8192, state: 'running' }]);
    await expect(service.placeForDock({ cpus: 2, memoryMiB: 4096 })).resolves.toBeNull();
  });

  it('ignores archived and errored docks and the dock being placed', async () => {
    const h = hostRow({ id: 'h1', vcpuTotal: 2, memTotalBytes: 4 * 1024 ** 3, maxDocks: 2 });
    useTx([h], [
      { id: 'old', hostId: 'h1', cpus: 2, memoryMiB: 4096, state: 'archived' },
      { id: 'bad', hostId: 'h1', cpus: 2, memoryMiB: 4096, state: 'error' },
    ]);
    await expect(service.placeForDock({ dockId: 'new', cpus: 2, memoryMiB: 4096 })).resolves.toMatchObject({ id: 'h1' });
  });

  it('skips excluded hosts', async () => {
    useTx([hostRow({ id: 'h1' }), hostRow({ id: 'h2' })]);
    await expect(service.placeForDock({ excludeHostIds: ['h1'] })).resolves.toMatchObject({ id: 'h2' });
  });

  it('keeps concurrent placements within capacity', async () => {
    const h = hostRow({ id: 'h1', vcpuTotal: 8, memTotalBytes: 16 * 1024 ** 3, maxDocks: 8 });
    const dockRows = useTx([h], [], { cpus: 2, memoryMiB: 4096 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => service.placeForDock({ dockId: `d${i}`, cpus: 2, memoryMiB: 4096 })));
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(dockRows).toHaveLength(4);
  });

  it('reports headroom ignoring family and runtime for exhaustion causes', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ usedDocks: 0, maxDocks: 8 })])).mockReturnValueOnce(selectQ([]));
    await expect(service.anyOnlineWithHeadroom()).resolves.toBe(true);
    db.select.mockReturnValueOnce(selectQ([hostRow({ usedDocks: 8, maxDocks: 8 })])).mockReturnValueOnce(selectQ([]));
    await expect(service.anyOnlineWithHeadroom()).resolves.toBe(false);
  });

  it('reports whether a size fits any online host total capacity', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.sizeFit({ cpus: 1, memoryMiB: 1024 })).resolves.toBe('none_online');
    const h = hostRow({ id: 'h1', vcpuTotal: 8, memTotalBytes: 16 * 1024 ** 3, memBudgetBytes: null });
    db.select.mockReturnValueOnce(selectQ([h]));
    await expect(service.sizeFit({ cpus: 8, memoryMiB: 16384 })).resolves.toBe('ok');
    db.select.mockReturnValueOnce(selectQ([h]));
    await expect(service.sizeFit({ cpus: 9, memoryMiB: 1024 })).resolves.toBe('too_large');
    db.select.mockReturnValueOnce(selectQ([h]));
    await expect(service.sizeFit({ cpus: 1, memoryMiB: 16385 })).resolves.toBe('too_large');
  });

  it('reports no headroom when committed sizes fill every host despite free slots', async () => {
    const h = hostRow({ id: 'h1', vcpuTotal: 8, memTotalBytes: 16 * 1024 ** 3, maxDocks: 8 });
    db.select.mockReturnValueOnce(selectQ([h])).mockReturnValueOnce(selectQ([{ hostId: 'h1', cpus: 8, memoryMiB: 16384 }]));
    await expect(service.anyOnlineWithHeadroom({ cpus: 1, memoryMiB: 2048 })).resolves.toBe(false);
  });

  it('ignores excluded hosts when reporting headroom', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ id: 'h1' })]));
    await expect(service.anyOnlineWithHeadroom({ excludeHostIds: ['h1'] })).resolves.toBe(false);
  });

  it('canPlace is advisory and filters on family, runtime and base like placement', async () => {
    const h = hostRow({ id: 'h1', cpuFamily: 'x86_64-v4', runtime: 'microvm', baseFingerprints: ['b'.repeat(64)] });
    db.select.mockReturnValueOnce(selectQ([h])).mockReturnValueOnce(selectQ([]));
    await expect(service.canPlace({ cpuFamily: 'x86_64-v4', runtime: 'microvm' })).resolves.toBe(true);
    db.select.mockReturnValueOnce(selectQ([h]));
    await expect(service.canPlace({ cpuFamily: 'aarch64' })).resolves.toBe(false);
    db.select.mockReturnValueOnce(selectQ([h]));
    await expect(service.canPlace({ runtime: 'gvisor' })).resolves.toBe(false);
    db.select.mockReturnValueOnce(selectQ([h]));
    const err = await catchErr(service.canPlace({ cpuFamily: 'x86_64-v4', baseFingerprint: 'c'.repeat(64) }));
    expect(err.body).toMatchObject({ code: 'base_image_unavailable' });
  });

  it('treats a registered zero memory budget as no capacity, unlike an unknown one', async () => {
    useTx([hostRow({ id: 'h1', vcpuTotal: 64, memTotalBytes: 8 * 1024 ** 3, memBudgetBytes: 0, maxDocks: 32 })]);
    await expect(service.placeForDock({ cpus: 1, memoryMiB: 2048 })).resolves.toBeNull();
    useTx([hostRow({ id: 'h1', vcpuTotal: 64, memTotalBytes: 8 * 1024 ** 3, memBudgetBytes: null, maxDocks: 32 })]);
    await expect(service.placeForDock({ cpus: 1, memoryMiB: 2048 })).resolves.toMatchObject({ id: 'h1' });
  });

  it('places against the registered guest memory budget instead of total RAM', async () => {
    const h = hostRow({ id: 'h1', vcpuTotal: 64, memTotalBytes: 8 * 1024 ** 3, memBudgetBytes: 4 * 1024 ** 3, maxDocks: 32 });
    useTx([h], [{ id: 'a', hostId: 'h1', cpus: 2, memoryMiB: 4096, state: 'running' }]);
    await expect(service.placeForDock({ cpus: 1, memoryMiB: 2048 })).resolves.toBeNull();
  });

  it('returns one host row by id for routing', async () => {
    db.select.mockReturnValueOnce(selectQ([hostRow({ id: 'h9' })]));
    await expect(service.getById('h9')).resolves.toMatchObject({ id: 'h9' });
    db.select.mockReturnValueOnce(selectQ([]));
    await expect(service.getById('ghost')).resolves.toBeNull();
  });

  it('lists every host for instance admins with a running count and no raw inventory', async () => {
    const rows = [hostRow({ running: [{ dockId: 'd1', state: 'running' }, { dockId: 'd2', state: 'running' }] }), hostRow({ id: 'h2', state: 'offline', running: [] })];
    db.select.mockReturnValueOnce({ from: () => ({ orderBy: () => Promise.resolve(rows) }) });
    const list = await service.listForAdmin({ email: 'Ops@Example.com', emailVerified: true });
    expect(list.map((h) => [h.id, h.state, h.runningDocks])).toEqual([['h1', 'online', 2], ['h2', 'offline', 0]]);
    expect(list[0]).not.toHaveProperty('running');
  });

  it('returns exactly the allowlisted host fields and drops secrets and extra columns', async () => {
    const rows = [
      hostRow({
        diskTotalBytes: 1,
        memBudgetBytes: 2,
        baseFingerprints: ['fp-secret'],
        credentialHash: 'deadbeef',
        running: [],
        extraFutureColumn: 'x',
      }),
    ];
    db.select.mockReturnValueOnce({ from: () => ({ orderBy: () => Promise.resolve(rows) }) });
    const [summary] = await service.listForAdmin({ email: 'ops@example.com', emailVerified: true });
    expect(Object.keys(summary).sort()).toEqual(
      [
        'id', 'address', 'cpuFamily', 'kernel', 'runtime', 'kernelRelease', 'vcpuTotal', 'memTotalBytes',
        'diskTotalBytes', 'maxDocks', 'usedDocks', 'runningDocks', 'state', 'lastHeartbeatAt', 'createdAt',
      ].sort(),
    );
    const json = JSON.stringify(summary);
    for (const leaked of ['deadbeef', 'credentialHash', 'fp-secret', 'extraFutureColumn']) expect(json).not.toContain(leaked);
  });

  it('refuses the host list to non-admins without querying', async () => {
    const err = await catchErr(service.listForAdmin({ email: 'member@example.com', emailVerified: true }));
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'instance_admin_required' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses a listed admin whose email is unverified or unknown', async () => {
    const unverified = await catchErr(service.listForAdmin({ email: 'ops@example.com', emailVerified: false }));
    expect(unverified.status).toBe(403);
    expect(unverified.body).toMatchObject({ code: 'email_verification_required', message: 'Verify your email to use instance admin features' });
    expect((await catchErr(service.getForAdmin({ email: 'ops@example.com' }, 'h1'))).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('details a host with its placed docks and flags reported runtimes no dock claims', async () => {
    const running = [
      { dockId: 'd1', state: 'running' },
      { dockId: 'old', state: 'running' },
      { dockId: 'ghost', state: 'running' },
      { dockId: 'run-1', state: 'running', kind: 'fast' },
    ];
    db.select.mockReturnValueOnce(selectQ([hostRow({ running })]));
    const placed = [{ id: 'd1', name: 'api', state: 'ready', workspaceName: 'Default', organizationName: 'acme' }];
    const join = { innerJoin: () => join, where: () => ({ orderBy: () => Promise.resolve(placed) }) };
    db.select.mockReturnValueOnce({ from: () => join });
    // An archived row still claims its runtime, exactly as the reconciler counts it.
    db.select.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([{ id: 'd1' }, { id: 'old' }]) }) });
    const detail = await service.getForAdmin({ email: 'ops@example.com', emailVerified: true }, 'h1');
    expect(detail).toMatchObject({
      id: 'h1',
      runningDocks: 4,
      docks: placed,
      runs: [{ dockId: 'run-1', state: 'running', kind: 'fast' }],
      orphans: [{ dockId: 'ghost', state: 'running' }],
    });
    expect(detail).not.toHaveProperty('running');
  });

  it('404s an unknown host and 403s non-admins before reading', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    expect((await catchErr(service.getForAdmin({ email: 'ops@example.com', emailVerified: true }, 'nope'))).body).toMatchObject({ code: 'host_not_found' });
    db.select.mockClear();
    expect((await catchErr(service.getForAdmin({ email: 'member@example.com', emailVerified: true }, 'h1'))).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
