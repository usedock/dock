import { PgDialect } from 'drizzle-orm/pg-core';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { hashToken } from '../crypto/tokens';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { FakeComputeProvider } from './compute.provider';
import { DocksService } from './docks.service';
import { BaseImageUnavailableException } from '../hosts/hosts.service';
import { DockletException } from '../runtime/docklet.client';
import { EnvironmentNotFoundException, EnvironmentSecretsAdminOnlyException } from '../environments/environments.service';
import { ConcurrencyExceededException, SubscriptionRequiredException } from '../metering/spend-errors';
import { vi } from 'vitest';

describe('DocksService', () => {
  let db: any;
  let orgs: any;
  let wsSvc: any;
  let retention: any;
  let ops: any;
  let envs: any;
  let provider: FakeComputeProvider;
  let metering: any;
  let spendGate: any;
  let hosts: any;
  let config: any;
  let webhooks: any;
  let notifications: any;
  let applier: any;
  let connectors: any;
  let service: DocksService;

  const orgId = '11111111-1111-4111-8111-111111111111';
  const wsId = '22222222-2222-4222-8222-222222222222';
  const dockId = '33333333-3333-4333-8333-333333333333';
  const dockRow = (overrides: Record<string, unknown> = {}) => ({
    id: dockId,
    workspaceId: wsId,
    name: 'dock-abc123',
    cpus: 2,
    memoryMiB: 4096,
    diskGiB: 20,
    image: 'ubuntu-24.04',
    runtime: 'microvm',
    state: 'ready',
    ttlSeconds: 3600,
    environment: 'base',
    envVersionPin: 'base',
    noEnv: false,
    env: {},
    fromTemplate: null,
    ip: '10.0.0.2',
    setupStatus: 'done',
    setupError: null,
    lastSnapshotAt: null,
    diskBytes: 0,
    billingPausedAt: null,
    ...overrides,
  });

  const selectQ = (rows: any[]) => {
    const p = Promise.resolve(rows);
    const where = () => ({ orderBy: () => ({ limit: () => p }), limit: () => p, then: p.then.bind(p) });
    return { from: () => ({ where }) };
  };
  const insertQ = (rows: any[]) => ({
    values: () => ({ returning: () => Promise.resolve(rows), onConflictDoUpdate: () => Promise.resolve(rows) }),
  });
  const updateQ = (rows: any[]) => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }),
  });
  const deleteQ = () => ({ where: () => Promise.resolve([]) });

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
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() };
    vi.clearAllMocks();
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'member' }) };
    spendGate = { requireSpend: vi.fn().mockResolvedValue(undefined) };
    metering = {
      openWindow: vi.fn().mockResolvedValue(undefined),
      closeWindowsForDock: vi.fn().mockResolvedValue(undefined),
      moveToStorage: vi.fn().mockResolvedValue(undefined),
      moveToCompute: vi.fn().mockResolvedValue(undefined),
    };
    wsSvc = { getById: vi.fn().mockResolvedValue({ id: wsId, organizationId: orgId }) };
    retention = { policyOn: vi.fn().mockResolvedValue(false) };
    ops = {
      create: vi.fn().mockResolvedValue({ id: 'op_1', status: 'pending' }),
      complete: vi.fn().mockResolvedValue({ id: 'op_1', status: 'completed' }),
      block: vi.fn().mockResolvedValue(undefined),
    };
    envs = {
      resolveVersion: vi.fn().mockResolvedValue({ environment: { name: 'base' }, version: { version: 1 } }),
      assertSecretsLaunchable: vi.fn().mockResolvedValue(undefined),
      assertDockSecretsReadable: vi.fn().mockResolvedValue(undefined),
    };
    provider = new FakeComputeProvider();
    hosts = { placeForDock: vi.fn(), canPlace: vi.fn().mockResolvedValue(true), getById: vi.fn().mockResolvedValue(null), anyOnlineWithHeadroom: vi.fn().mockResolvedValue(true), sizeFit: vi.fn().mockResolvedValue('ok') };
    config = { get: vi.fn().mockReturnValue('fake') };
    webhooks = { record: vi.fn().mockResolvedValue({ id: 'evt-1' }) };
    notifications = { dockStopRefused: vi.fn().mockResolvedValue(null) };
    applier = { apply: vi.fn().mockImplementation(async (dock: unknown) => dock) };
    connectors = { assertConnected: vi.fn().mockImplementation(async (_ws: string, kinds: string[]) => kinds) };
    service = new DocksService(db as never, orgs as never, wsSvc as never, retention as never, ops as never, provider as never, envs as never, metering as never, spendGate as never, hosts as never, config as never, webhooks as never, notifications as never, applier as never, connectors as never);
  });

  it('creates a ready dock with defaults', async () => {
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    db.update.mockReturnValueOnce(updateQ([dockRow()])); // bindKey touches update only via idempotency path; harmless
    const dock = await service.create('u1', { workspaceId: wsId });
    expect(dock).toMatchObject({ workspaceId: wsId, cpus: 2, memoryMiB: 4096, diskGiB: 20, image: 'ubuntu-24.04', ttlSeconds: 3600, state: 'ready' });
    expect(dock.ip).toMatch(/^10\.0\.0\.\d+$/);
    expect(webhooks.record).toHaveBeenCalledWith({ type: 'dock.ready', dockId: dock.id, organizationId: orgId, workspaceId: wsId, state: 'ready' });
  });

  it('checks requested connectors against the workspace and stores them on the dock', async () => {
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    const values = vi.fn().mockReturnValue({ returning: () => Promise.resolve([dockRow({ state: 'provisioning', ip: null })]) });
    db.insert.mockReset();
    db.insert.mockReturnValue({ values });
    db.update.mockReturnValue(updateQ([dockRow()]));
    orgs.requireMembership.mockResolvedValue({ role: 'admin' });
    await service.create('u1', { workspaceId: wsId, connectors: ['linear', 'figma'] });
    expect(connectors.assertConnected).toHaveBeenCalledWith(wsId, ['linear', 'figma']);
    expect(values.mock.calls[0][0].connectors).toEqual(['linear', 'figma']);
  });

  it('refuses to create a dock when a connector is not connected, before inserting anything', async () => {
    const { ConnectorNotConnectedException } = await import('../connectors/connectors.service');
    connectors.assertConnected.mockRejectedValueOnce(new ConnectorNotConnectedException(['slack']));
    const err = await catchErr(service.create('u1', { workspaceId: wsId, connectors: ['slack'] }));
    expect(err).toMatchObject({ status: 409, body: { code: 'connector_not_connected' } });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('applies the environment after ready, skipping egress-confined run docks', async () => {
    db.insert.mockReturnValue(insertQ([dockRow({ state: 'provisioning', ip: null, setupStatus: 'pending' })]));
    db.update.mockReturnValue(updateQ([dockRow({ setupStatus: 'pending' })]));
    applier.apply.mockResolvedValueOnce(dockRow({ setupStatus: 'done' }));
    const dock = await service.create('u1', { workspaceId: wsId, setupScript: 'make' });
    expect(applier.apply).toHaveBeenCalledWith(expect.objectContaining({ id: dockId }), orgId, { setupScript: 'make' });
    expect(dock.setupStatus).toBe('done');
    await service.create('u1', { workspaceId: wsId, egressAllow: ['github.com'] });
    expect(applier.apply).toHaveBeenCalledTimes(1);
  });

  it('boots in the org default environment when none is named', async () => {
    envs.resolveVersion.mockResolvedValueOnce({ environment: { name: 'web' }, version: { version: 4 } });
    const seen: any[] = [];
    db.insert.mockReturnValueOnce({ values: (v: unknown) => { seen.push(v); return { returning: () => Promise.resolve([dockRow({ state: 'provisioning' })]) }; } });
    db.update.mockReturnValue(updateQ([dockRow()]));
    await service.create('u1', { workspaceId: wsId });
    expect(envs.resolveVersion).toHaveBeenCalledWith(orgId, undefined);
    expect(seen[0]).toMatchObject({ environment: 'web', envVersionPin: 'v4' });
  });

  it('persists the provider hostId so the reconciler can correlate', async () => {
    const spy = vi.spyOn(provider, 'provision').mockResolvedValueOnce({ ip: '10.9.9.9', hostId: 'host-1' });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, hostId: null })]));
    const seen: { set?: unknown } = {};
    db.update.mockReturnValue({ set: (values: unknown) => { seen.set = values; return { where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }; } });
    await service.create('u1', { workspaceId: wsId });
    expect(seen.set).toMatchObject({ state: 'ready', ip: '10.9.9.9', hostId: 'host-1', stateChangedAt: expect.any(Date) });
    spy.mockRestore();
  });

  it('confines egress only when an internal caller passes an allowlist', async () => {
    const spy = vi.spyOn(provider, 'provision');
    db.insert.mockReturnValue(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.create('u1', { workspaceId: wsId });
    expect(spy.mock.calls[0][1]).not.toHaveProperty('egressAllow');
    await service.create('u1', { workspaceId: wsId, egressAllow: ['github.com'] });
    expect(spy.mock.calls[1][1]).toMatchObject({ egressAllow: ['github.com'] });
    await service.create('u1', { workspaceId: wsId, egressAllow: [] });
    expect(spy.mock.calls[2][1]).not.toHaveProperty('egressAllow');
    spy.mockRestore();
  });

  it('places restate creates through the scheduler', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-9' });
    const spy = vi.spyOn(provider, 'provision').mockResolvedValueOnce({ ip: '10.9.9.9', hostId: 'host-9' });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, hostId: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.create('u1', { workspaceId: wsId });
    expect(hosts.placeForDock).toHaveBeenCalledWith({ cpuFamily: undefined, runtime: null, dockId: expect.any(String), cpus: 2, memoryMiB: 4096, excludeHostIds: [] });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { snapshotId: null, hostId: 'host-9' });
    spy.mockRestore();
  });

  it('re-places on another host when the docklet refuses with capacity_exhausted', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-full' }).mockResolvedValueOnce({ id: 'host-2' });
    const spy = vi
      .spyOn(provider, 'provision')
      .mockRejectedValueOnce(Object.assign(new Error('over budget'), { code: 'capacity_exhausted' }))
      .mockResolvedValueOnce({ ip: '10.9.9.2', hostId: 'host-2' });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, hostId: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.create('u1', { workspaceId: wsId });
    expect(hosts.placeForDock).toHaveBeenLastCalledWith(expect.objectContaining({ excludeHostIds: ['host-full'] }));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('fails with capacity_exhausted once every host refused', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-full' }).mockResolvedValueOnce(null);
    hosts.anyOnlineWithHeadroom.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const spy = vi.spyOn(provider, 'provision').mockRejectedValueOnce(Object.assign(new Error('over budget'), { code: 'capacity_exhausted' }));
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, hostId: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    const err = await catchErr(service.create('u1', { workspaceId: wsId }));
    expect(err.body).toMatchObject({ code: 'capacity_exhausted' });
    spy.mockRestore();
  });

  it('refuses restate resume with 503 when no host qualifies', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce(null);
    hosts.anyOnlineWithHeadroom.mockResolvedValueOnce(false);
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'aarch64' }]));
    db.update.mockReturnValue(updateQ([dockRow({ state: 'provisioning' })]));
    const err = await catchErr(service.resume('u1', dockId));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'capacity_exhausted' });
    expect(hosts.placeForDock).toHaveBeenCalledWith({ cpuFamily: 'aarch64', runtime: null, dockId, cpus: 2, memoryMiB: 4096, excludeHostIds: [] });
  });
  it('routes restate resume at the placed host', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-2' });
    const spy = vi.spyOn(provider, 'resume').mockResolvedValueOnce({ ip: '10.9.9.2', hostId: 'host-2' });
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'x86_64-v4' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await expect(service.resume('u1', dockId)).resolves.toEqual({ id: dockId, state: 'ready' });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { snapshotId: 'gen-1', hostId: 'host-2' });
    spy.mockRestore();
  });

  it('refuses create when the subscription cannot spend', async () => {
    spendGate.requireSpend.mockRejectedValueOnce(new SubscriptionRequiredException());
    const err = await catchErr(service.create('u1', { workspaceId: wsId }));
    expect(err.status).toBe(402);
    expect(err.body).toMatchObject({ code: 'subscription_required' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses resume at the concurrency cap', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived', diskBytes: 10 })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    spendGate.requireSpend.mockRejectedValueOnce(new ConcurrencyExceededException());
    const err = await catchErr(service.resume('u1', dockId));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'concurrency_exceeded' });
  });

  it('opens a metering window when a dock reaches ready', async () => {
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    const dock = await service.create('u1', { workspaceId: wsId });
    expect(metering.openWindow).toHaveBeenCalledWith({
      organizationId: orgId,
      workspaceId: wsId,
      dockId: dock.id,
      cpus: 2,
      memoryMiB: 4096,
      diskGiB: 20,
    });
  });

  it('opens a storage window when a dock archives', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-2', status: 'completed' }]));
    const out = await service.stop('u1', dockId);
    expect(out).toEqual({ id: dockId, state: 'archived' });
    expect(metering.moveToStorage).toHaveBeenCalledWith({ organizationId: orgId, workspaceId: wsId, dockId, cpus: 2, memoryMiB: 4096, diskGiB: 20 });
  });

  it('destroys the runtime on a forced stop, even if destroy fails, and still moves billing to storage', async () => {
    const destroy = vi.spyOn(provider, 'destroyBacking').mockRejectedValueOnce(new Error('host_unreachable'));
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    db.update.mockReturnValue(updateQ([dockRow()]));
    const out = await service.stop('u1', dockId, { force: true });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ id: dockId, state: 'archived' });
    expect(metering.moveToStorage).toHaveBeenCalledWith(expect.objectContaining({ dockId }));
  });

  it('closes billing when destroy fails during remove', async () => {
    vi.spyOn(provider, 'destroyBacking').mockRejectedValueOnce(new Error('host_unreachable'));
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([])); // no snapshots to back a template
    let seenSet: Record<string, unknown> | undefined;
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    db.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => ((seenSet = v), { where: () => Promise.resolve([]) }) });
    await expect(service.remove('u1', dockId, dockId)).rejects.toThrow('host_unreachable');
    expect(seenSet).toMatchObject({ billingPausedAt: expect.any(Date) });
    expect(ops.block).toHaveBeenCalledWith('op_1');
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith(dockId);
  });

  it('rejects unknown environments before creating anything', async () => {
    envs.resolveVersion.mockRejectedValueOnce(new EnvironmentNotFoundException());
    const err = await catchErr(service.create('u1', { workspaceId: wsId, environment: 'nope' }));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'environment_not_found' });
    expect(wsSvc.getById).toHaveBeenCalledWith('u1', wsId);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('validates sizes, ttl, and env', async () => {
    for (const input of [
      { workspaceId: wsId, cpus: 0 },
      { workspaceId: wsId, memoryMiB: 256 },
      { workspaceId: wsId, diskGiB: 0 },
      { workspaceId: wsId, cpus: 1.5 },
      { workspaceId: wsId, ttlSeconds: 5 },
      { workspaceId: wsId, env: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, 'v'])) },
    ]) {
      const err = await catchErr(service.create('u1', input as never));
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: 'validation_error' });
    }
  });

  it('records the requested size on the dock and its metering window', async () => {
    const inserted: Record<string, unknown>[] = [];
    db.insert.mockReturnValueOnce({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ ...v, state: 'provisioning', ip: null })]) }; } });
    db.update.mockReturnValueOnce(updateQ([dockRow({ cpus: 8, memoryMiB: 16384, diskGiB: 80 })]));
    await service.create('u1', { workspaceId: wsId, cpus: 8, memoryMiB: 16384, diskGiB: 80 });
    expect(inserted[0]).toMatchObject({ cpus: 8, memoryMiB: 16384, diskGiB: 80, image: 'ubuntu-24.04' });
    expect(metering.openWindow).toHaveBeenCalledWith(expect.objectContaining({ cpus: 8, memoryMiB: 16384, diskGiB: 80 }));
  });

  it('applies defaults and generates a name when none is given', async () => {
    const inserted: Record<string, unknown>[] = [];
    db.insert.mockReturnValueOnce({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ ...v, state: 'provisioning', ip: null })]) }; } });
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    await service.create('u1', { workspaceId: wsId });
    expect(inserted[0]).toMatchObject({ cpus: 2, memoryMiB: 4096, diskGiB: 20, image: 'ubuntu-24.04' });
    expect(inserted[0].name).toMatch(/^dock-[0-9a-f]{8}$/);
  });

  it('rejects images outside the Dockyard catalog with image_unknown before creating anything', async () => {
    const err = await catchErr(service.create('u1', { workspaceId: wsId, image: 'debian-12' }));
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ code: 'image_unknown', message: 'Unknown image. Valid images: ubuntu-24.04, node-22, python-3.12, browser' });
    expect(db.insert).not.toHaveBeenCalled();
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    await expect(service.create('u1', { workspaceId: wsId, image: 'ubuntu-24.04' })).resolves.toMatchObject({ state: 'ready' });
  });

  it('accepts a non-default catalog image', async () => {
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, image: 'node-22' })]));
    db.update.mockReturnValueOnce(updateQ([dockRow({ image: 'node-22' })]));
    await expect(service.create('u1', { workspaceId: wsId, image: 'node-22' })).resolves.toMatchObject({ image: 'node-22' });
    expect(db.insert.mock.calls[0]).toBeDefined();
  });

  it('refuses a name already used in the workspace with 409 dock_name_taken', async () => {
    db.select.mockReturnValueOnce(selectQ([{ id: 'dock-other' }]));
    const err = await catchErr(service.create('u1', { workspaceId: wsId, name: 'taken' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'dock_name_taken' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('maps a racing duplicate-name insert to dock_name_taken', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    db.insert.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, name: 'racy' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'dock_name_taken' });
  });

  it('keeps a free name as given, trimmed', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const inserted: Record<string, unknown>[] = [];
    db.insert.mockReturnValueOnce({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ ...v, state: 'provisioning', ip: null })]) }; } });
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    await service.create('u1', { workspaceId: wsId, name: '  build-box  ' });
    expect(inserted[0].name).toBe('build-box');
  });

  it('places by the requested cpus and memory', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-big', runtime: 'gvisor' });
    const spy = vi.spyOn(provider, 'provision').mockResolvedValueOnce({ ip: '10.9.9.3', hostId: 'host-big' });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, hostId: null, cpus: 8, memoryMiB: 16384 })]));
    const updates: Record<string, unknown>[] = [];
    db.update.mockImplementation(() => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: () => ({ returning: () => Promise.resolve([dockRow({ runtime: 'gvisor' })]) }) }; } }));
    await service.create('u1', { workspaceId: wsId, cpus: 8, memoryMiB: 16384 });
    expect(hosts.placeForDock).toHaveBeenCalledWith(expect.objectContaining({ cpus: 8, memoryMiB: 16384 }));
    expect(updates[0]).toMatchObject({ state: 'ready', hostId: 'host-big', runtime: 'gvisor' });
    spy.mockRestore();
  });

  it('refuses with capacity_exhausted before inserting when no host has room for the size', async () => {
    config.get.mockReturnValue('restate');
    hosts.anyOnlineWithHeadroom.mockResolvedValueOnce(false);
    const err = await catchErr(service.create('u1', { workspaceId: wsId, cpus: 64 }));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'capacity_exhausted' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('reports no_host_capacity before inserting when no host is online', async () => {
    config.get.mockReturnValue('restate');
    hosts.sizeFit.mockResolvedValueOnce('none_online');
    const err = await catchErr(service.create('u1', { workspaceId: wsId }));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'no_host_capacity' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects with 400 validation_error before inserting when the size exceeds every online host', async () => {
    config.get.mockReturnValue('restate');
    hosts.sizeFit.mockResolvedValueOnce('too_large');
    const err = await catchErr(service.create('u1', { workspaceId: wsId, cpus: 64 }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(String(err.body.message)).toContain('exceeds the total capacity');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('frees the name after a too-large create so a retry with a valid size succeeds', async () => {
    config.get.mockReturnValue('restate');
    hosts.sizeFit.mockResolvedValueOnce('too_large');
    const refused = await catchErr(service.create('u1', { workspaceId: wsId, name: 'retry-me', cpus: 64 }));
    expect(refused.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
    db.select.mockReturnValueOnce(selectQ([]));
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-1' });
    const spy = vi.spyOn(provider, 'provision').mockResolvedValueOnce({ ip: '10.9.9.8', hostId: 'host-1' });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ name: 'retry-me', state: 'provisioning', ip: null, hostId: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await expect(service.create('u1', { workspaceId: wsId, name: 'retry-me', cpus: 2 })).resolves.toMatchObject({ state: 'ready' });
    expect(db.insert).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('leaves no row when a branch size exceeds every online host, and the name stays free', async () => {
    config.get.mockReturnValue('restate');
    const source = () => db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    source();
    hosts.sizeFit.mockResolvedValueOnce('too_large');
    const err = await catchErr(service.branch('u1', dockId, { name: 'fork-a', cpus: 64 }));
    expect(err.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
    source();
    db.select.mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([{ id: 'snap-9', status: 'completed' }]));
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-1' });
    db.insert
      .mockReturnValueOnce(insertQ([dockRow({ id: 'dock-new', name: 'fork-a', state: 'provisioning' })]))
      .mockReturnValueOnce(insertQ([{ id: 'snap-10' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', state: 'ready' })]) }) }) });
    await expect(service.branch('u1', dockId, { name: 'fork-a', cpus: 2 })).resolves.toMatchObject({ state: 'ready' });
  });

  it('leaves no row when a branch finds no host with room', async () => {
    config.get.mockReturnValue('restate');
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    hosts.anyOnlineWithHeadroom.mockResolvedValueOnce(false);
    const err = await catchErr(service.branch('u1', dockId, { cpus: 8 }));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'capacity_exhausted' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('skips hosts that refuse a catalog image and reports 400 image_unavailable once hosts run out', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-a' }).mockResolvedValueOnce({ id: 'host-b' }).mockResolvedValueOnce(null);
    hosts.anyOnlineWithHeadroom.mockResolvedValue(true);
    const refused = () => new DockletException('image_unavailable', 'image_unavailable: "node-22"');
    const spy = vi.spyOn(provider, 'provision').mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, image: 'node-22' })]));
    db.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, image: 'node-22' }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'image_unavailable' });
    expect(err.body.message).toContain('node-22');
    expect(hosts.placeForDock).toHaveBeenLastCalledWith(expect.objectContaining({ excludeHostIds: ['host-a', 'host-b'] }));
    spy.mockRestore();
  });

  it('refuses a branch to another image before creating anything', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ image: 'ubuntu-24.04' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const err = await catchErr(service.branch('u1', dockId, { image: 'node-22' }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('reports no_host_capacity when room exists but family or runtime rules it out', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce(null);
    hosts.anyOnlineWithHeadroom.mockResolvedValueOnce(true);
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    const err = await catchErr(service.create('u1', { workspaceId: wsId }));
    expect(err.body).toMatchObject({ code: 'no_host_capacity' });
  });

  it('leaves no row when no online host runs the template runtime, and frees the key', async () => {
    config.get.mockReturnValue('restate');
    db.select.mockReturnValueOnce(selectQ([{ name: 'gv-stack', status: 'ready', storeSnapshotId: 'gen-own', cpuFamily: 'GenuineIntel:142:1', runtime: 'gvisor' }]));
    hosts.canPlace.mockResolvedValueOnce(false);
    db.insert.mockReturnValueOnce({ values: () => Promise.resolve([]) });
    const deleted = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValueOnce({ where: deleted });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, from: 'gv-stack' }, 'k1'));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'no_host_capacity' });
    expect(hosts.canPlace).toHaveBeenCalledWith(expect.objectContaining({ cpuFamily: 'GenuineIntel:142:1', runtime: 'gvisor' }));
    expect(db.insert).toHaveBeenCalledTimes(1); // the idempotency key only
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(hosts.placeForDock).not.toHaveBeenCalled();
  });

  it('skips the family check for a create with no template', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-1' });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.create('u1', { workspaceId: wsId });
    expect(hosts.canPlace).not.toHaveBeenCalled();
  });

  it('leaves no row when no host of the source family has room for a branch, and frees the key', async () => {
    config.get.mockReturnValue('restate');
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ hostId: 'host-src', runtime: 'microvm' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    hosts.getById.mockResolvedValueOnce({ id: 'host-src', cpuFamily: 'GenuineIntel:142:1' });
    hosts.canPlace.mockResolvedValueOnce(false);
    db.insert.mockReturnValueOnce({ values: () => Promise.resolve([]) });
    const deleted = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValueOnce({ where: deleted });
    const err = await catchErr(service.branch('u1', dockId, { name: 'fork-f' }, 'k1'));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'no_host_capacity' });
    expect(hosts.canPlace).toHaveBeenCalledWith(expect.objectContaining({ cpuFamily: 'GenuineIntel:142:1', runtime: 'microvm' }));
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('pins a template boot to the runtime that captured it', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-gv', runtime: 'gvisor' });
    db.select.mockReturnValueOnce(selectQ([{ name: 'gv-stack', status: 'ready', storeSnapshotId: 'gen-own', runtime: 'gvisor' }]));
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null, hostId: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ runtime: 'gvisor' })]) }) }) });
    const spy = vi.spyOn(provider, 'provision').mockResolvedValueOnce({ ip: '10.9.9.4', hostId: 'host-gv' });
    await service.create('u1', { workspaceId: wsId, from: 'gv-stack' });
    expect(hosts.placeForDock).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'gvisor' }));
    spy.mockRestore();
  });

  it('resumes onto the runtime the snapshot was captured on', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-gv', runtime: 'gvisor' });
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived', runtime: 'gvisor' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'GenuineIntel:142:1', runtime: 'gvisor' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ runtime: 'gvisor' })]) }) }) });
    await expect(service.resume('u1', dockId)).resolves.toEqual({ id: dockId, state: 'ready' });
    expect(hosts.placeForDock).toHaveBeenCalledWith({ cpuFamily: 'GenuineIntel:142:1', runtime: 'gvisor', dockId, cpus: 2, memoryMiB: 4096, excludeHostIds: [] });
  });

  it('keeps a dock archived and resumable when resume placement refuses it', async () => {
    config.get.mockReturnValue('restate');
    for (const [fit, status] of [['too_large', 400], ['none_online', 503]] as const) {
      hosts.placeForDock.mockResolvedValueOnce(null);
      hosts.sizeFit.mockResolvedValueOnce(fit);
      db.select
        .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
        .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
        .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
      const sets: Record<string, unknown>[] = [];
      db.update.mockImplementation(() => ({ set: (v: Record<string, unknown>) => { sets.push(v); const p = Promise.resolve([dockRow({ state: 'provisioning' })]); return { where: () => Object.assign(p, { returning: () => p }) }; } }));
      const err = await catchErr(service.resume('u1', dockId, { cpus: 64 }));
      expect(err.status).toBe(status);
      expect(sets.map((s) => s.state)).toEqual(['provisioning', 'archived']);
    }
    expect(webhooks.record).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dock.error' }));
  });

  it('resumes with a new size and meters it', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const sets: Record<string, unknown>[] = [];
    db.update.mockImplementation(() => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: () => ({ returning: () => Promise.resolve([dockRow({ state: 'ready' })]) }) }; } }));
    await service.resume('u1', dockId, { cpus: 4, memoryMiB: 8192 });
    expect(sets[1]).toMatchObject({ cpus: 4, memoryMiB: 8192, diskGiB: 20 });
    expect(metering.moveToCompute).toHaveBeenCalledWith(expect.objectContaining({ cpus: 4, memoryMiB: 8192, diskGiB: 20 }));
  });

  it('swaps the storage window for compute in one step on resume', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    db.update.mockImplementation(() => updateQ([dockRow({ state: 'ready' })]));
    await service.resume('u1', dockId);
    expect(metering.moveToCompute).toHaveBeenCalledWith({ organizationId: orgId, workspaceId: wsId, dockId, cpus: 2, memoryMiB: 4096, diskGiB: 20 });
    expect(metering.openWindow).not.toHaveBeenCalled();
    expect(metering.closeWindowsForDock).not.toHaveBeenCalled();
  });

  it('branches inherit the source size and image and may override them', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ cpus: 4, memoryMiB: 8192, diskGiB: 40 })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-9', status: 'completed' }]));
    const inserted: Record<string, unknown>[] = [];
    db.insert
      .mockReturnValueOnce({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ id: 'dock-new', ...v })]) }; } })
      .mockReturnValueOnce(insertQ([{ id: 'snap-10' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', state: 'ready' })]) }) }) });
    await service.branch('u1', dockId);
    expect(inserted[0]).toMatchObject({ cpus: 4, memoryMiB: 8192, diskGiB: 40, image: 'ubuntu-24.04' });
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ cpus: 4, memoryMiB: 8192, diskGiB: 40 })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-11', status: 'completed' }]));
    db.insert
      .mockReturnValueOnce({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ id: 'dock-up', ...v })]) }; } })
      .mockReturnValueOnce(insertQ([{ id: 'snap-12' }]));
    await service.branch('u1', dockId, { cpus: 1 });
    expect(inserted[1]).toMatchObject({ cpus: 1, memoryMiB: 8192, diskGiB: 40 });
  });

  it('updates a dock name only when it is free and rejects a name another dock holds', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'dock-other' }]));
    const err = await catchErr(service.update('u1', dockId, { name: 'taken' }));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'dock_name_taken' });
  });

  it('records the capturing runtime on stop', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ runtime: 'gvisor' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]));
    const seen: Record<string, unknown>[] = [];
    db.insert.mockReturnValueOnce({
      values: (v: Record<string, unknown>) => {
        seen.push(v);
        return { returning: () => Promise.resolve([{ id: 'snap-1' }]) };
      },
    });
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.stop('u1', dockId);
    expect(seen[0]).toMatchObject({ runtime: 'gvisor', kernelRelease: null });
  });

  it('records the base fingerprint of a microVM capture on stop', async () => {
    const fp = 'e'.repeat(64);
    vi.spyOn(provider, 'captureFinal').mockResolvedValueOnce({
      snapshotId: 'gen-7', sizeBytes: 10, cpuFamily: 'x86_64-v4', runtime: 'microvm', kernelRelease: null, baseFingerprint: fp, manifest: { files: [] },
    });
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([]));
    const seen: Record<string, unknown>[] = [];
    db.insert.mockReturnValueOnce({
      values: (v: Record<string, unknown>) => {
        seen.push(v);
        return { returning: () => Promise.resolve([{ id: 'snap-1' }]) };
      },
    });
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.stop('u1', dockId);
    expect(seen[0]).toMatchObject({ storeSnapshotId: 'gen-7', runtime: 'microvm', baseFingerprint: fp });
  });

  it('places a resume only where the snapshot base is held', async () => {
    const fp = 'f'.repeat(64);
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-2' });
    const spy = vi.spyOn(provider, 'resume').mockResolvedValueOnce({ ip: '10.9.9.2', hostId: 'host-2' });
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'x86_64-v4', baseFingerprint: fp }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await service.resume('u1', dockId);
    expect(hosts.placeForDock).toHaveBeenCalledWith({ cpuFamily: 'x86_64-v4', runtime: null, dockId, cpus: 2, memoryMiB: 4096, excludeHostIds: [], baseFingerprint: fp });
    spy.mockRestore();
  });

  it('fails a resume with base_image_unavailable when no host holds the base', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockRejectedValueOnce(new BaseImageUnavailableException());
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'x86_64-v4', baseFingerprint: 'a'.repeat(64) }]));
    db.update.mockReturnValue(updateQ([dockRow({ state: 'provisioning' })]));
    const spy = vi.spyOn(provider, 'resume');
    const err = await catchErr(service.resume('u1', dockId));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'base_image_unavailable' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips a host whose docklet lacks the base and reports the base once hosts run out', async () => {
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-a' }).mockResolvedValueOnce({ id: 'host-b' }).mockResolvedValueOnce(null);
    const missing = () => Object.assign(new Error('base image is not on this host'), { code: 'base_image_unavailable' });
    const spy = vi.spyOn(provider, 'resume').mockRejectedValueOnce(missing()).mockRejectedValueOnce(missing());
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'x86_64-v4', baseFingerprint: null }]));
    db.update.mockReturnValue(updateQ([dockRow({ state: 'provisioning' })]));
    const err = await catchErr(service.resume('u1', dockId));
    expect(err.body).toMatchObject({ code: 'base_image_unavailable' });
    expect(hosts.placeForDock).toHaveBeenLastCalledWith(expect.objectContaining({ excludeHostIds: ['host-a', 'host-b'] }));
    spy.mockRestore();
  });

  it('places a template boot on a host holding the template base', async () => {
    const fp = 'd'.repeat(64);
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-3' });
    db.select.mockReturnValueOnce(
      selectQ([{ name: 'web-stack', status: 'ready', storeSnapshotId: 'gen-own', cpuFamily: 'x86_64-v4', runtime: 'microvm', baseFingerprint: fp }]),
    );
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    const spy = vi.spyOn(provider, 'provision').mockResolvedValueOnce({ ip: '10.9.9.3', hostId: 'host-3' });
    await service.create('u1', { workspaceId: wsId, from: 'web-stack' });
    expect(hosts.placeForDock).toHaveBeenCalledWith(expect.objectContaining({ cpuFamily: 'x86_64-v4', baseFingerprint: fp }));
    spy.mockRestore();
  });

  it('resolves from templates in the target workspace org', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ name: 'web-stack', status: 'ready' }])); // template lookup
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow({ fromTemplate: 'web-stack' })]));
    const dock = await service.create('u1', { workspaceId: wsId, from: 'web-stack' });
    expect(dock.fromTemplate).toBe('web-stack');
  });

  it('looks template names up only in the workspace org', async () => {
    const wheres: unknown[] = [];
    const p = Promise.resolve([{ name: 'web-stack', status: 'ready' }]);
    db.select.mockReturnValueOnce({
      from: () => ({
        where: (w: unknown) => {
          wheres.push(w);
          return { limit: () => p };
        },
      }),
    });
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow({ fromTemplate: 'web-stack' })]));
    await service.create('u1', { workspaceId: wsId, from: 'web-stack' });
    expect(wheres).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(wheres[0] as never).params).toEqual([orgId, 'web-stack']);
  });

  it('boots from the template snapshot generation when pinned', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ name: 'web-stack', status: 'ready', snapshotRef: 'snap-9' }])) // template
      .mockReturnValueOnce(selectQ([{ id: 'snap-9', storeSnapshotId: 'gen-9' }])); // snapshot row
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow({ fromTemplate: 'web-stack' })]));
    const spy = vi.spyOn(provider, 'provision');
    const dock = await service.create('u1', { workspaceId: wsId, from: 'web-stack' });
    expect(dock.fromTemplate).toBe('web-stack');
    expect(spy).toHaveBeenCalledWith(expect.anything(), { snapshotId: 'gen-9', hostId: null });
    spy.mockRestore();
  });

  it('boots from the generation the template captured itself', async () => {
    db.select
      .mockReturnValueOnce(
        selectQ([{ name: 'web-stack', status: 'ready', snapshotRef: 'snap-old', storeSnapshotId: 'gen-own', runtime: 'microvm' }]),
      );
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow({ fromTemplate: 'web-stack' })]));
    const spy = vi.spyOn(provider, 'provision');
    await service.create('u1', { workspaceId: wsId, from: 'web-stack' });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { snapshotId: 'gen-own', hostId: null });
    spy.mockRestore();
  });

  it('refuses to delete a dock whose snapshot backs a snapshot-only template', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 's1' }]))
      .mockReturnValueOnce(selectQ([{ name: 'web-stack' }]));
    const refused = await catchErr(service.remove('u1', dockId, dockId));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'snapshot_in_use', message: expect.stringContaining('web-stack') });
    expect(ops.create).not.toHaveBeenCalled();
  });

  it('lets only the creator or an org admin delete a dock', async () => {
    const selects = () =>
      db.select
        .mockReturnValueOnce(selectQ([dockRow({ createdBy: 'owner-user' })]))
        .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    orgs.requireMembership.mockImplementation(async (_o: string, _u: string, role?: string) => {
      if (role === 'admin') throw new ForbiddenException({ code: 'forbidden' });
      return { role: 'member' };
    });
    selects();
    const refused = await catchErr(service.remove('other-member', dockId, dockId));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'dock_delete_forbidden' });
    expect(ops.create).not.toHaveBeenCalled();
    db.select.mockReturnValueOnce(selectQ([dockRow({ createdBy: null })])).mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    expect((await catchErr(service.remove('other-member', dockId, dockId))).status).toBe(403);
    orgs.requireMembership.mockResolvedValue({ role: 'member' });
    selects();
    db.select.mockReturnValueOnce(selectQ([])).mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    db.delete.mockReturnValue(deleteQ());
    await service.remove('owner-user', dockId, dockId);
    expect(ops.create).toHaveBeenCalledWith(orgId, 'dock', dockId);
  });

  it('lets an org admin who is not the creator delete a dock', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ createdBy: 'owner-user' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    db.delete.mockReturnValue(deleteQ());
    await service.remove('admin-user', dockId, dockId);
    expect(orgs.requireMembership).toHaveBeenCalledWith(orgId, 'admin-user', 'admin');
    expect(ops.create).toHaveBeenCalledWith(orgId, 'dock', dockId);
  });

  it('applies delete rights to ZDR stops only', async () => {
    const dockSelects = () =>
      db.select
        .mockReturnValueOnce(selectQ([dockRow({ createdBy: 'owner-user' })]))
        .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    orgs.requireMembership.mockImplementation(async (_o: string, _u: string, role?: string) => {
      if (role === 'admin') throw new ForbiddenException({ code: 'forbidden' });
      return { role: 'member' };
    });
    retention.policyOn.mockResolvedValue(true);
    dockSelects();
    const refused = await catchErr(service.stop('other-member', dockId));
    expect(refused.body).toMatchObject({ code: 'dock_delete_forbidden' });
    expect(db.update).not.toHaveBeenCalled();
    retention.policyOn.mockResolvedValue(false);
    dockSelects();
    db.select.mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValue(updateQ([dockRow()]));
    db.insert.mockReturnValue(insertQ([{ id: 'snap-1' }]));
    expect(await service.stop('other-member', dockId)).toEqual({ id: dockId, state: 'archived' });
  });

  it('fails when the template snapshot row is gone', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ name: 'web-stack', status: 'ready', snapshotRef: 'snap-gone' }])) // template
      .mockReturnValueOnce(selectQ([])); // snapshot row gone
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    const spy = vi.spyOn(provider, 'provision');
    const failed = await catchErr(service.create('u1', { workspaceId: wsId, from: 'web-stack' }));
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ code: 'template_source_missing' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('recovers interrupted transitions on boot', async () => {
    db.select
      .mockReturnValueOnce(
        selectQ([dockRow({ state: 'archiving' }), dockRow({ id: 'dock-stuck', state: 'provisioning' })]),
      )
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // org for the archiving dock
      .mockReturnValueOnce(selectQ([])) // latest snapshot for the archiving dock
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])); // org for the provisioning dock
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-9' }]));
    db.update.mockReturnValue(updateQ([dockRow()]));
    const res = await service.recoverInterrupted();
    expect(webhooks.record).toHaveBeenCalledWith({ type: 'dock.archived', dockId, organizationId: orgId, workspaceId: wsId, state: 'archived' });
    expect(webhooks.record).toHaveBeenCalledWith({ type: 'dock.error', dockId: 'dock-stuck', organizationId: orgId, workspaceId: wsId, state: 'error' });
    expect(res).toEqual({ archived: 1, errored: 1 });
  });

  it('leaves archiving docks running when recovery capture fails', async () => {
    provider.failNextCapture(1);
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archiving' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // org for the archiving dock
      .mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValue(updateQ([dockRow()]));
    const res = await service.recoverInterrupted();
    expect(res).toEqual({ archived: 0, errored: 0 });
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith(dockId);
  });

  it('returns 404 template_not_found for unknown from names', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const err = await catchErr(service.create('u1', { workspaceId: wsId, from: 'nope-missing' }));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'template_not_found' });
  });

  it('replays the same dock for the same key and body', async () => {
    const input = { workspaceId: wsId };
    const bodyHash = hashToken(JSON.stringify(input));
    db.insert.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    db.select
      .mockReturnValueOnce(selectQ([{ scope: `org:${orgId}`, key: 'k1', bodyHash, dockId: 'dock-9', createdAt: new Date() }]))
      .mockReturnValueOnce(selectQ([dockRow({ id: 'dock-9' })]));
    const dock = await service.create('u1', input, 'k1');
    expect(dock.id).toBe('dock-9');
  });

  it('replays a named create for the same key instead of refusing its own name', async () => {
    const input = { workspaceId: wsId, name: 'api' };
    const bodyHash = hashToken(JSON.stringify(input));
    db.insert.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    db.select
      .mockReturnValueOnce(selectQ([{ scope: `org:${orgId}`, key: 'k1', bodyHash, dockId: 'dock-9', createdAt: new Date() }]))
      .mockReturnValueOnce(selectQ([dockRow({ id: 'dock-9', name: 'api' })]));
    const dock = await service.create('u1', input, 'k1');
    expect(dock).toMatchObject({ id: 'dock-9', name: 'api' });
  });

  it('frees the claimed key when the name is taken so a renamed retry is not stuck in progress', async () => {
    db.insert.mockReturnValueOnce({ values: () => Promise.resolve([]) });
    db.select.mockReturnValueOnce(selectQ([{ id: 'dock-other' }]));
    const deleted = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValueOnce({ where: deleted });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, name: 'taken' }, 'k1'));
    expect(err.body).toMatchObject({ code: 'dock_name_taken' });
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('frees the claimed key when the size is refused so a resized retry with the same key is not rejected as reused', async () => {
    config.get.mockReturnValue('restate');
    hosts.sizeFit.mockResolvedValueOnce('too_large');
    db.insert.mockReturnValueOnce({ values: () => Promise.resolve([]) });
    const deleted = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValueOnce({ where: deleted });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, name: 'big', cpus: 64 }, 'k1'));
    expect(err.status).toBe(400);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('frees the claimed key when a branch size is refused', async () => {
    config.get.mockReturnValue('restate');
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    hosts.anyOnlineWithHeadroom.mockResolvedValueOnce(false);
    db.insert.mockReturnValueOnce({ values: () => Promise.resolve([]) });
    const deleted = vi.fn().mockResolvedValue([]);
    db.delete.mockReturnValueOnce({ where: deleted });
    const err = await catchErr(service.branch('u1', dockId, { cpus: 8 }, 'k1'));
    expect(err.body).toMatchObject({ code: 'capacity_exhausted' });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('refuses a size change on a live dock and records it on a stopped one', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'ready' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const err = await catchErr(service.update('u1', dockId, { cpus: 64 }));
    expect(err.status).toBe(409);
    expect(db.update).not.toHaveBeenCalled();
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const sets: Record<string, unknown>[] = [];
    db.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: () => ({ returning: () => Promise.resolve([dockRow({ state: 'archived', cpus: 4 })]) }) }; } });
    await service.update('u1', dockId, { cpus: 4 });
    expect(sets[0]).toMatchObject({ cpus: 4, memoryMiB: 4096, diskGiB: 20 });
  });

  it('rejects the same key with a different body', async () => {
    db.insert.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    db.select.mockReturnValueOnce(
      selectQ([{ scope: `org:${orgId}`, key: 'k1', bodyHash: 'other-hash', dockId: 'dock-9', createdAt: new Date() }]),
    );
    const err = await catchErr(service.create('u1', { workspaceId: wsId, cpus: 1 }, 'k1'));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('reports in-flight creations for fresh keys without a dock', async () => {
    db.insert.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    db.select.mockReturnValueOnce(
      selectQ([
        {
          scope: `org:${orgId}`,
          key: 'k1',
          bodyHash: hashToken(JSON.stringify({ workspaceId: wsId })),
          dockId: null,
          createdAt: new Date(),
        },
      ]),
    );
    const err = await catchErr(service.create('u1', { workspaceId: wsId }, 'k1'));
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'idempotency_in_progress' });
  });

  it('hides missing, malformed, and foreign docks as 404', async () => {
    db.select.mockReturnValueOnce(selectQ([]));
    const missing = await catchErr(service.getById('u1', dockId));
    expect(missing).toMatchObject({ status: 404, body: expect.objectContaining({ code: 'dock_not_found' }) });
    const malformed = await catchErr(service.getById('u1', 'nope'));
    expect(malformed.status).toBe(404);
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const foreign = await catchErr(service.getById('stranger', dockId));
    expect(foreign.body).toMatchObject({ code: 'dock_not_found' });
  });

  it('lists with state-group filters and all=true', async () => {
    db.select
      .mockReturnValueOnce(selectQ([{ organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: wsId }]))
      .mockReturnValueOnce(selectQ([dockRow()]));
    await expect(service.list('u1', 'sr', false)).resolves.toHaveLength(1);
    const bad = await catchErr(service.list('u1', 'z', false));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'validation_error' });
  });

  it('stops with a final snapshot and archives', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()])) // loadDock dock
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // workspace
      .mockReturnValueOnce(selectQ([])); // latest snapshot
    const sets: any[] = [];
    db.update.mockReturnValue({ set: (s: any) => { sets.push(s); return { where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }; } });
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-1' }]));
    const res = await service.stop('u1', dockId);
    expect(res).toEqual({ id: dockId, state: 'archived' });
    expect(sets.find((s) => s.state === 'archived')).toMatchObject({ stateChangedAt: expect.any(Date) });
    expect(webhooks.record).toHaveBeenCalledWith({ type: 'dock.archived', dockId, organizationId: orgId, workspaceId: wsId, state: 'archived' });
  });

  it('resumes once when two resumes read archived: the loser conflicts and provisions nothing', async () => {
    const spy = vi.spyOn(provider, 'resume');
    const snap = { id: 'snap-1', status: 'completed', storeSnapshotId: null, cpuFamily: null };
    for (let i = 0; i < 2; i += 1) {
      db.select
        .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
        .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
        .mockReturnValueOnce(selectQ([snap]));
    }
    // The first claim matches archived; the second finds the row already moved.
    db.update.mockReturnValueOnce(updateQ([dockRow({ state: 'provisioning' })])).mockReturnValueOnce(updateQ([dockRow({ state: 'ready' })]));
    db.update.mockReturnValueOnce(updateQ([]));
    await expect(service.resume('u1', dockId)).resolves.toEqual({ id: dockId, state: 'ready' });
    const err = await catchErr(service.resume('u1', dockId));
    expect(err.status).toBe(409);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(metering.moveToCompute).toHaveBeenCalledTimes(1);
  });

  it('skips ZDR orgs, and keeps sweeping past a failing dock', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ id: 'bad', ttlSeconds: 60 }), dockRow({ id: 'zdr', ttlSeconds: 60 }), dockRow({ ttlSeconds: 60 })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // bad: org
      .mockReturnValueOnce(selectQ([])) // bad: latest snapshot
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: 'zdr-org' }])) // zdr: org
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // ok: org
      .mockReturnValueOnce(selectQ([])); // ok: latest snapshot
    retention.policyOn.mockImplementation(async (_db: unknown, org: string) => org === 'zdr-org');
    const spy = vi.spyOn(provider, 'captureFinal').mockRejectedValueOnce(new Error('boom'));
    db.update.mockReturnValue(updateQ([dockRow()]));
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-1' }]));
    expect(await service.sweepExpiredTtl()).toEqual([dockId]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('queries only explicit ttls on docks without a paused billing marker, one sweep at a time', async () => {
    let sweepSql = '';
    const dialect = new PgDialect();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    db.select.mockReturnValueOnce({
      from: () => ({
        where: (cond: any) => {
          sweepSql = dialect.sqlToQuery(cond).sql;
          return { orderBy: () => ({ limit: () => gate.then(() => []) }) };
        },
      }),
    });
    const running = service.sweepExpiredTtl();
    expect(await service.sweepExpiredTtl()).toEqual([]);
    release();
    await running;
    expect(sweepSql).toContain('"ttl_seconds" IS NOT NULL');
    expect(sweepSql).toContain('"billing_paused_at" is null');
  });

  it('does not insert a second snapshot row for a generation already recorded', async () => {
    const existing = { id: 'snap-1', dockId, storeSnapshotId: 'gen-1' };
    db.select.mockReturnValueOnce(selectQ([existing]));
    const snap = await (service as any).recordSnapshot(dockId, 1, {}, null, 'gen-1', undefined);
    expect(snap).toBe(existing);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('aborts stop with a conflict when another transition moved the state first', async () => {
    const spy = vi.spyOn(provider, 'captureFinal');
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    db.update.mockReturnValueOnce(updateQ([]));
    const err = await catchErr(service.stop('u1', dockId));
    expect(err.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops docks past their ttl and skips the rest', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ ttlSeconds: 60 })])) // expired docks
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // org for workspace
      .mockReturnValueOnce(selectQ([])); // latest snapshot
    const sets: any[] = [];
    db.update.mockReturnValue({ set: (v: any) => { sets.push(v); return { where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }; } });
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-1' }]));
    expect(await service.sweepExpiredTtl()).toEqual([dockId]);
    expect(sets.some((v) => v.state === 'archived')).toBe(true);
    expect(metering.moveToStorage).toHaveBeenCalledWith(expect.objectContaining({ dockId }));
    db.select.mockReturnValueOnce(selectQ([]));
    expect(await service.sweepExpiredTtl()).toEqual([]);
  });

  it('refuses stop when the final capture fails, pausing billing', async () => {
    provider.failNextCapture(1);
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]));
    const sets: any[] = [];
    db.update.mockReturnValue({ set: (s: any) => { sets.push(s); return { where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }; } });
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-1' }]));
    const err = await catchErr(service.stop('u1', dockId));
    expect(err.status).toBe(503);
    expect(err.body).toMatchObject({ code: 'service_unavailable' });
    const restore = sets.find((s) => s.billingPausedAt instanceof Date);
    expect(restore).toMatchObject({ state: 'ready' });
    expect(restore.stateChangedAt).toBeUndefined();
    expect(notifications.dockStopRefused).toHaveBeenCalledWith({
      dockId,
      workspaceId: wsId,
      dockName: 'dock-abc123',
      at: expect.any(Date),
    });
  });

  it('replays stop while archiving without a second capture', async () => {
    const spy = vi.spyOn(provider, 'captureFinal');
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archiving' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const res = await service.stop('u1', dockId);
    expect(res).toEqual({ id: dockId, state: 'archiving' });
    expect(spy).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resumes a crash-interrupted archiving dock with exactly one final snapshot', async () => {
    const spy = vi.spyOn(provider, 'captureFinal');
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archiving' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // org for the archiving dock
      .mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-final' }]));
    db.update.mockReturnValue(updateQ([dockRow({ state: 'archived' })]));
    const first = await service.recoverInterrupted();
    expect(first).toEqual({ archived: 1, errored: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    db.select.mockReturnValueOnce(selectQ([]));
    const second = await service.recoverInterrupted();
    expect(second).toEqual({ archived: 0, errored: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('adopts an orphaned capture instead of recording twice', async () => {
    const busy = new DockletException('snapshot_in_progress', 'another capture is running');
    const spy = vi.spyOn(provider, 'captureFinal');
    spy.mockRejectedValueOnce(busy);
    spy.mockImplementationOnce(async (dock, parent) => provider.captureSnapshot(dock, parent));
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archiving' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }])) // org for the archiving dock
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([]));
    db.insert.mockReturnValueOnce(insertQ([{ id: 'snap-adopted' }]));
    db.update.mockReturnValue(updateQ([dockRow({ state: 'archived' })]));
    const res = await service.recoverInterrupted();
    expect(res).toEqual({ archived: 1, errored: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(1);
  }, 15000);

  it('runs interrupted recovery on boot', async () => {
    const spy = vi.spyOn(service, 'recoverInterrupted').mockResolvedValueOnce({ archived: 0, errored: 0 });
    service.onModuleInit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('deletes rows instead of snapshotting when retention is on', async () => {
    retention.policyOn.mockResolvedValueOnce(true);
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    db.delete.mockReturnValue(deleteQ());
    db.select.mockReturnValueOnce(selectQ([]));
    const res = await service.stop('u1', dockId);
    expect(res).toEqual({ id: dockId, state: 'archived' });
    expect(db.delete).toHaveBeenCalledTimes(2);
  });

  it('destroys the VM and deletes unreferenced generations when retention is on', async () => {
    retention.policyOn.mockResolvedValueOnce(true);
    const destroy = vi.spyOn(provider, 'destroyBacking');
    const del = vi.spyOn(provider, 'deleteBacking');
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([
        { id: 's1', storeSnapshotId: 'g1' },
        { id: 's2', storeSnapshotId: 'g2' },
        { id: 's3', storeSnapshotId: 'g3' },
        { id: 's4', storeSnapshotId: null },
      ]))
      .mockReturnValueOnce(selectQ([{ snapshotRef: null, storeSnapshotId: 'g2' }])) // templates
      .mockReturnValueOnce(selectQ([{ storeSnapshotId: 'g3' }])); // other snapshot rows
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    db.delete.mockReturnValue(deleteQ());
    await service.stop('u1', dockId);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(del.mock.calls).toEqual([['g1']]);
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(db.delete.mock.invocationCallOrder[0]);
  });

  it('keeps a generation only for snapshot-backed templates and deletes rows first', async () => {
    retention.policyOn.mockResolvedValueOnce(true);
    const del = vi.spyOn(provider, 'deleteBacking');
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([
        { id: 's1', storeSnapshotId: 'g1' },
        { id: 's2', storeSnapshotId: 'g2' },
      ]))
      .mockReturnValueOnce(selectQ([
        { snapshotRef: 's1', storeSnapshotId: null }, // references only: keeps g1
        { snapshotRef: 's2', storeSnapshotId: 'own' }, // owns a generation: g2 is free
      ]))
      .mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    db.delete.mockReturnValue(deleteQ());
    await service.stop('u1', dockId);
    expect(del.mock.calls).toEqual([['g2']]);
    expect(db.delete.mock.invocationCallOrder[1]).toBeLessThan(del.mock.invocationCallOrder[0]);
  });

  it('keeps going when generation or VM cleanup fails', async () => {
    retention.policyOn.mockResolvedValueOnce(true);
    vi.spyOn(provider, 'destroyBacking').mockRejectedValueOnce(new Error('vm gone'));
    const del = vi.spyOn(provider, 'deleteBacking').mockRejectedValueOnce(new Error('store down'));
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 's1', storeSnapshotId: 'g1' }, { id: 's2', storeSnapshotId: 'g2' }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    db.delete.mockReturnValue(deleteQ());
    await expect(service.stop('u1', dockId)).resolves.toEqual({ id: dockId, state: 'archived' });
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('resumes from the latest completed snapshot', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    await expect(service.resume('u1', dockId)).resolves.toEqual({ id: dockId, state: 'ready' });
    expect(webhooks.record).toHaveBeenCalledWith({ type: 'dock.hydrated', dockId, organizationId: orgId, workspaceId: wsId, state: 'ready' });
    expect(webhooks.record).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dock.ready' }));
  });

  it('stops then resumes through the fake provider without hand-fed snapshot rows', async () => {
    let recorded: any = null;
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }) });
    db.insert.mockReturnValueOnce({
      values: (v: any) => {
        recorded = { id: 'snap-1', ...v };
        return { returning: () => Promise.resolve([recorded]) };
      },
    });
    await service.stop('u1', dockId);
    expect(recorded?.storeSnapshotId).toBeNull();
    const spy = vi.spyOn(provider, 'resume');
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([recorded]));
    await expect(service.resume('u1', dockId)).resolves.toEqual({ id: dockId, state: 'ready' });
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ snapshotId: null }));
  });

  it('rejects resume without a snapshot and shrinks that do not fit', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]));
    const empty = await catchErr(service.resume('u1', dockId));
    expect(empty.status).toBe(409);
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived', diskBytes: 11 * 1024 ** 3 })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const shrink = await catchErr(service.resume('u1', dockId, { diskGiB: 10 }));
    expect(shrink.status).toBe(409);
  });

  it('branches with merged env and a fresh default ttl', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ env: { A: '1' } })])) // loadDock
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-9', status: 'completed' }])); // latest
    const inserted: any[] = [];
    db.insert
      .mockReturnValueOnce({ values: (v: any) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ id: 'dock-new', ...v })]) }; } })
      .mockReturnValueOnce(insertQ([{ id: 'snap-10' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', state: 'ready' })]) }) }) });
    const fork = await service.branch('u1', dockId, { env: { B: '2' } });
    expect(fork.id).toBe('dock-new');
    expect(inserted[0]).toMatchObject({ ttlSeconds: null, env: { A: '1', B: '2' } });
    expect(webhooks.record).toHaveBeenCalledWith({ type: 'dock.ready', dockId: 'dock-new', organizationId: orgId, workspaceId: wsId, state: 'ready' });
  });

  it('places a branch only where the captured base is held', async () => {
    const fp = '7'.repeat(64);
    config.get.mockReturnValue('restate');
    hosts.placeForDock.mockResolvedValueOnce({ id: 'host-4' });
    vi.spyOn(provider, 'captureSnapshot').mockResolvedValueOnce({
      snapshotId: 'gen-11', sizeBytes: 10, cpuFamily: 'x86_64-v4', runtime: 'microvm', kernelRelease: null, baseFingerprint: fp, manifest: { files: [] },
    });
    const branchSpy = vi.spyOn(provider, 'branch').mockResolvedValueOnce({ ip: '10.9.9.4', hostId: 'host-4' });
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([]))
      .mockReturnValueOnce(selectQ([]));
    db.insert
      .mockReturnValueOnce(insertQ([dockRow({ id: 'dock-new', state: 'provisioning' })]))
      .mockReturnValueOnce(insertQ([{ id: 'snap-11' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', state: 'ready' })]) }) }) });
    await service.branch('u1', dockId);
    expect(hosts.placeForDock).toHaveBeenCalledWith(expect.objectContaining({ cpuFamily: 'x86_64-v4', baseFingerprint: fp, dockId: 'dock-new' }));
    expect(branchSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ snapshotId: 'gen-11', hostId: 'host-4' }));
    branchSpy.mockRestore();
  });

  /** Records every update().set() payload while returning a ready dock. */
  const captureSets = () => {
    const sets: Array<Record<string, any>> = [];
    db.update.mockReturnValue({ set: (v: Record<string, any>) => (sets.push(v), { where: () => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', state: 'ready' })]) }) }) });
    return sets;
  };

  it('stamps liveSince when create reaches ready', async () => {
    db.insert.mockReturnValueOnce(insertQ([dockRow({ state: 'provisioning', ip: null })]));
    const sets = captureSets();
    await service.create('u1', { workspaceId: wsId });
    const ready = sets.find((s) => s.state === 'ready');
    expect(ready?.liveSince).toBeInstanceOf(Date);
  });

  it('resume leaves envBoundAt alone unless the environment or noEnv changes', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const sets = captureSets();
    await service.resume('u1', dockId);
    expect(sets.find((x) => x.state === 'ready')).not.toHaveProperty('envBoundAt');

    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const sets2 = captureSets();
    await service.resume('u1', dockId, { noEnv: true });
    expect(sets2.find((x) => x.state === 'ready')?.envBoundAt).toBeInstanceOf(Date);
  });

  it('clears liveSince when resume starts and stamps it on success', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1', cpuFamily: 'x86_64-v4' }]));
    const sets = captureSets();
    await service.resume('u1', dockId);
    const start = sets.find((s) => s.state === 'provisioning');
    expect(start).toHaveProperty('liveSince', null);
    expect(sets.find((s) => s.state === 'ready')?.liveSince).toBeInstanceOf(Date);
  });

  it('stamps liveSince when branch reaches ready', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ env: {} })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-9', status: 'completed' }]));
    db.insert
      .mockReturnValueOnce({ values: (v: any) => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', ...v })]) }) })
      .mockReturnValueOnce(insertQ([{ id: 'snap-10' }]));
    const sets = captureSets();
    await service.branch('u1', dockId, {});
    expect(sets.find((s) => s.state === 'ready')?.liveSince).toBeInstanceOf(Date);
  });

  it('requires confirmation for deletes and 404s afterwards', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const refused = await catchErr(service.remove('u1', dockId, 'wrong'));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'confirm_required' });
    db.select
      .mockReturnValueOnce(selectQ([dockRow()]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    db.select.mockReturnValueOnce(selectQ([{ id: 's1' }, { id: 's2' }])); // template-backing check
    db.select.mockReturnValueOnce(selectQ([])); // no backed template
    db.select.mockReturnValueOnce(selectQ([{ id: 's1', storeSnapshotId: 'g1' }, { id: 's2', storeSnapshotId: 'g2' }]));
    db.select.mockReturnValueOnce(selectQ([]));
    db.select.mockReturnValueOnce(selectQ([]));
    const del = vi.spyOn(provider, 'deleteBacking');
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    db.delete.mockReturnValue(deleteQ());
    const done = await service.remove('u1', dockId, dockId);
    expect(del.mock.calls).toEqual([['g1'], ['g2']]);
    expect(metering.closeWindowsForDock).toHaveBeenCalledWith(dockId);
    expect(metering.moveToStorage).not.toHaveBeenCalled();
    expect(done).toEqual({ operation: { id: 'op_1', status: 'completed' } });
    expect(ops.create).toHaveBeenCalledWith(orgId, 'dock', dockId);
    db.select.mockReturnValueOnce(selectQ([]));
    const gone = await catchErr(service.getById('u1', dockId));
    expect(gone.body).toMatchObject({ code: 'dock_not_found' });
  });

  it('pins the latest environment version and posture on create', async () => {
    envs.resolveVersion.mockResolvedValueOnce({ environment: { name: 'staging' }, version: { version: 3 } });
    const inserted: any[] = [];
    db.insert.mockReturnValueOnce({
      values: (v: any) => {
        inserted.push(v);
        return { returning: () => Promise.resolve([dockRow({ state: 'provisioning', ip: null, ...v })]) };
      },
    });
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    await service.create('u1', { workspaceId: wsId, environment: 'staging', noEnv: true });
    expect(envs.resolveVersion).toHaveBeenCalledWith(orgId, 'staging');
    expect(inserted[0]).toMatchObject({ environment: 'staging', envVersionPin: 'v3', noEnv: true });
    expect(inserted[0].envBoundAt).toBeInstanceOf(Date);
  });

  it('create asks the secrets guard before billing, inserts or provisioning', async () => {
    envs.resolveVersion.mockResolvedValueOnce({ environment: { name: 'prod' }, version: { version: 3 } });
    envs.assertSecretsLaunchable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    const err = await catchErr(service.create('u1', { workspaceId: wsId, environment: 'prod' }));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    expect(envs.assertSecretsLaunchable).toHaveBeenCalledWith('u1', orgId, 'prod', { pin: 'v3', noEnv: undefined });
    expect(spendGate.requireSpend).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('create skips the secrets guard for egress-confined run docks', async () => {
    db.insert.mockReturnValueOnce({ values: (v: any) => ({ returning: () => Promise.resolve([dockRow({ state: 'provisioning', ip: null, ...v })]) }) });
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    await service.create('u1', { workspaceId: wsId, egressAllow: ['api.usedock.io'] });
    expect(envs.assertSecretsLaunchable).not.toHaveBeenCalled();
  });

  it('resume checks the secrets guard before billing and any state change', async () => {
    envs.assertSecretsLaunchable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived', environment: 'prod', envVersionPin: 'v2', createdBy: 'owner-user' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const err = await catchErr(service.resume('u1', dockId));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    expect(envs.assertSecretsLaunchable).toHaveBeenCalledWith('u1', orgId, 'prod', { pin: 'v2', noEnv: false, creatorId: 'owner-user' });
    expect(spendGate.requireSpend).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('branch checks the secrets guard before billing and inserting the target', async () => {
    envs.assertSecretsLaunchable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ environment: 'prod', envVersionPin: 'v2' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const err = await catchErr(service.branch('u1', dockId));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    expect(envs.assertSecretsLaunchable).toHaveBeenCalledWith('u1', orgId, 'prod', { pin: 'v2', noEnv: false });
    expect(spendGate.requireSpend).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('branch checks the source dock bundle even when the target drops env or switches environment', async () => {
    for (const opts of [{ noEnv: true }, { environment: 'other' }]) {
      envs.assertDockSecretsReadable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
      db.select
        .mockReturnValueOnce(selectQ([dockRow({ createdBy: 'admin-1', environment: 'prod', envVersionPin: 'v2' })]))
        .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
      const err = await catchErr(service.branch('u1', dockId, opts));
      expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
      expect(envs.assertDockSecretsReadable).toHaveBeenLastCalledWith('u1', orgId, expect.objectContaining({ environment: 'prod', envVersionPin: 'v2', noEnv: false }));
    }
    expect(spendGate.requireSpend).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('resume checks the recorded env and pin even with noEnv', async () => {
    envs.assertDockSecretsReadable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived', createdBy: 'admin-1', environment: 'prod', envVersionPin: 'v2' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    const err = await catchErr(service.resume('u1', dockId, { noEnv: true }));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    expect(envs.assertDockSecretsReadable).toHaveBeenCalledWith('u1', orgId, expect.objectContaining({ environment: 'prod', envVersionPin: 'v2' }));
    expect(spendGate.requireSpend).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('create from a template checks the dock the template was saved from', async () => {
    envs.assertDockSecretsReadable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    db.select
      .mockReturnValueOnce(selectQ([{ name: 'web-stack', status: 'ready', sourceDockId: 'src-dock' }]))
      .mockReturnValueOnce(selectQ([dockRow({ id: 'src-dock', createdBy: 'admin-1', environment: 'prod', envVersionPin: 'v2' })]));
    const err = await catchErr(service.create('u1', { workspaceId: wsId, noEnv: true, from: 'web-stack' }));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    expect(envs.assertDockSecretsReadable).toHaveBeenCalledWith('u1', orgId, expect.objectContaining({ id: 'src-dock', environment: 'prod' }));
    expect(spendGate.requireSpend).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('create from a template whose source dock is gone refuses members but lets admins through', async () => {
    const queueTemplate = () =>
      db.select
        .mockReturnValueOnce(selectQ([{ name: 'web-stack', status: 'ready', sourceDockId: 'src-dock' }]))
        .mockReturnValueOnce(selectQ([]));
    queueTemplate();
    orgs.requireMembership.mockResolvedValueOnce({ role: 'member' });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, noEnv: true, from: 'web-stack' }));
    expect(err).toMatchObject({ status: 403, body: expect.objectContaining({ code: 'environment_secrets_admin_only' }) });
    expect(envs.assertDockSecretsReadable).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    queueTemplate();
    orgs.requireMembership.mockResolvedValueOnce({ role: 'admin' });
    db.insert.mockReturnValueOnce({ values: (v: any) => ({ returning: () => Promise.resolve([dockRow({ state: 'provisioning', ip: null, ...v })]) }) });
    db.update.mockReturnValueOnce(updateQ([dockRow()]));
    await expect(service.create('u1', { workspaceId: wsId, noEnv: true, from: 'web-stack' })).resolves.toBeDefined();
  });

  it('refuses members a dock with connectors, before inserting anything', async () => {
    orgs.requireMembership.mockResolvedValue({ role: 'member' });
    const err = await catchErr(service.create('u1', { workspaceId: wsId, connectors: ['slack'] }));
    expect(err).toMatchObject({ status: 403, body: { code: 'connector_admin_only' } });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('loadReadableDock refuses members a dock with connectors they did not create, but not its creator or admins', async () => {
    const row = dockRow({ createdBy: 'admin-1', connectors: ['slack'] });
    const load = () => db.select.mockReturnValueOnce(selectQ([row])).mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    orgs.requireMembership.mockResolvedValue({ role: 'member' });
    load();
    expect(await catchErr(service.loadReadableDock('u1', dockId))).toMatchObject({ status: 403, body: { code: 'connector_admin_only' } });
    load();
    await expect(service.loadReadableDock('admin-1', dockId)).resolves.toEqual({ dock: row, orgId });
    orgs.requireMembership.mockResolvedValue({ role: 'admin' });
    load();
    await expect(service.loadReadableDock('u1', dockId)).resolves.toEqual({ dock: row, orgId });
  });

  it('loadReadableDock asks the guard with the loaded dock', async () => {
    const row = dockRow({ createdBy: 'admin-1' });
    db.select.mockReturnValueOnce(selectQ([row])).mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    await expect(service.loadReadableDock('u1', dockId)).resolves.toEqual({ dock: row, orgId });
    expect(envs.assertDockSecretsReadable).toHaveBeenCalledWith('u1', orgId, row);
    envs.assertDockSecretsReadable.mockRejectedValueOnce(new EnvironmentSecretsAdminOnlyException());
    db.select.mockReturnValueOnce(selectQ([row])).mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]));
    expect(await catchErr(service.loadReadableDock('u1', dockId))).toMatchObject({ status: 403 });
  });

  it('rejects reserved per-dock env keys', async () => {
    const err = await catchErr(service.create('u1', { workspaceId: wsId, env: { DOCK_ID: 'evil' } }));
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: 'validation_error' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('resume re-pins to a named environment and refuses unknown ones', async () => {
    envs.resolveVersion.mockResolvedValueOnce({ environment: { name: 'prod' }, version: { version: 5 } });
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const sets: any[] = [];
    db.update.mockReturnValue({ set: (s: any) => { sets.push(s); return { where: () => ({ returning: () => Promise.resolve([dockRow()]) }) }; } });
    await expect(service.resume('u1', dockId, { environment: 'prod' })).resolves.toEqual({ id: dockId, state: 'ready' });
    expect(sets[1]).toMatchObject({ environment: 'prod', envVersionPin: 'v5' });
    expect(sets[1].envBoundAt).toBeInstanceOf(Date);

    envs.resolveVersion.mockRejectedValueOnce(new EnvironmentNotFoundException());
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ state: 'archived' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const unknown = await catchErr(service.resume('u1', dockId, { environment: 'nope' }));
    expect(unknown).toMatchObject({ status: 404, body: expect.objectContaining({ code: 'environment_not_found' }) });
  });

  it('branch inherits the source pin unless a new environment is named', async () => {
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ environment: 'staging', envVersionPin: 'v2' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-9', status: 'completed' }]));
    const inserted: any[] = [];
    db.insert
      .mockReturnValueOnce({ values: (v: any) => { inserted.push(v); return { returning: () => Promise.resolve([dockRow({ id: 'dock-new', ...v })]) }; } })
      .mockReturnValueOnce(insertQ([{ id: 'snap-10' }]));
    db.update.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([dockRow({ id: 'dock-new', state: 'ready' })]) }) }) });
    await service.branch('u1', dockId);
    expect(inserted[0]).toMatchObject({ environment: 'staging', envVersionPin: 'v2', noEnv: false });
    expect(inserted[0].envBoundAt).toBeInstanceOf(Date);
    expect(envs.resolveVersion).not.toHaveBeenCalled();

    envs.resolveVersion.mockResolvedValueOnce({ environment: { name: 'prod' }, version: { version: 4 } });
    db.select
      .mockReturnValueOnce(selectQ([dockRow({ environment: 'staging', envVersionPin: 'v2' })]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-9', status: 'completed' }]));
    const renamed: any[] = [];
    db.insert
      .mockReturnValueOnce({ values: (v: any) => { renamed.push(v); return { returning: () => Promise.resolve([dockRow({ id: 'dock-new', ...v })]) }; } })
      .mockReturnValueOnce(insertQ([{ id: 'snap-10' }]));
    await service.branch('u1', dockId, { environment: 'prod' });
    expect(renamed[0]).toMatchObject({ environment: 'prod', envVersionPin: 'v4', noEnv: false });
  });

  it('resume without a size keeps the dock size', async () => {
    const archived = dockRow({ state: 'archived', cpus: 4, memoryMiB: 8192, diskGiB: 40 });
    db.select
      .mockReturnValueOnce(selectQ([archived]))
      .mockReturnValueOnce(selectQ([{ id: wsId, organizationId: orgId }]))
      .mockReturnValueOnce(selectQ([{ id: 'snap-1', status: 'completed', storeSnapshotId: 'gen-1' }]));
    const sets: any[] = [];
    db.update.mockImplementation(() => ({
      set: (values: unknown) => {
        sets.push(values);
        return { where: () => ({ returning: () => Promise.resolve([dockRow({ state: 'ready' })]) }) };
      },
    }));
    const res = await service.resume('u1', dockId, {});
    expect(res).toEqual({ id: dockId, state: 'ready' });
    expect(sets).toHaveLength(2);
    expect(sets[1]).toMatchObject({ cpus: 4, memoryMiB: 8192, diskGiB: 40 });
  });
});
