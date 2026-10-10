import { vi, type Mock } from 'vitest';
import type { ObjectContext, WorkflowContext } from '@restatedev/restate-sdk';
import type { DockState } from '../database/schema';
import {
  buildRuntimeOps,
  canResumeFrom,
  canStopFrom,
  dockObject,
  dockTtlWorkflow,
  getRuntimeOps,
  idempotencyTokenFor,
  runBranch,
  runProvision,
  runResume,
  runStop,
  runTtl,
  setRuntimeOps,
  ttlDelayMs,
  ttlTimerName,
  type DocksPort,
  type RuntimeOps,
} from './dock-workflow';

const ALL_STATES: DockState[] = [
  'provisioning',
  'provisioned',
  'cloning',
  'ready',
  'idle',
  'running',
  'error',
  'archiving',
  'archived',
];

const fakeOps = (): RuntimeOps & Record<'provision' | 'stop' | 'resume' | 'branch' | 'sleepForTtl', Mock> => ({
  provision: vi.fn().mockResolvedValue({ id: 'd1' }),
  stop: vi.fn().mockResolvedValue({ id: 'd1', state: 'archived' }),
  resume: vi.fn().mockResolvedValue({ id: 'd1', state: 'ready' }),
  branch: vi.fn().mockResolvedValue({ id: 'd2' }),
  sleepForTtl: vi.fn().mockResolvedValue(undefined),
});

// Inline ctx.run: executes the journaled closure immediately.
const inlineCtx = (run = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn())) =>
  ({ run }) as unknown as ObjectContext;

describe('dock-workflow planner', () => {
  it('stops from every known dock state like DocksService.stop', () => {
    for (const state of ALL_STATES) expect(canStopFrom(state)).toBe(true);
  });

  it('resumes only from archived like DocksService.resume', () => {
    for (const state of ALL_STATES) expect(canResumeFrom(state)).toBe(state === 'archived');
  });

  it('issues stable tokens scoped by workflow and op', () => {
    expect(idempotencyTokenFor('d1', 'provision')).toBe('d1:provision');
    expect(idempotencyTokenFor('d1', 'provision')).toBe(idempotencyTokenFor('d1', 'provision'));
    expect(idempotencyTokenFor('d1', 'stop')).not.toBe(idempotencyTokenFor('d1', 'provision'));
    expect(idempotencyTokenFor('d1', 'stop')).not.toBe(idempotencyTokenFor('d2', 'stop'));
  });

  it('names TTL timers per dock and converts seconds to ms', () => {
    expect(ttlTimerName('d1')).toBe('ttl-d1');
    expect(ttlTimerName('d1')).not.toBe(ttlTimerName('d2'));
    expect(ttlDelayMs(60)).toBe(60000);
  });
});

describe('dock-workflow handler delegation', () => {
  it('runs provision once inside ctx.run with the dock key', async () => {
    const ops = fakeOps();
    const input = { callerId: 'u1', create: { workspaceId: 'w1' } };
    await expect(runProvision(inlineCtx(), ops, 'd1', input)).resolves.toEqual({ id: 'd1' });
    expect(ops.provision).toHaveBeenCalledTimes(1);
    expect(ops.provision).toHaveBeenCalledWith('d1', input);
  });

  it('re-resolves the host on replay by passing only the dock id', async () => {
    const ops = fakeOps();
    let currentHost: string | null = 'h1';
    ops.provision.mockImplementation(async (dockId: string) => ({ id: dockId, hostId: currentHost }));
    const input = { callerId: 'u1', create: { workspaceId: 'w1' } };
    await expect(runProvision(inlineCtx(), ops, 'd1', input)).resolves.toMatchObject({ hostId: 'h1' });
    currentHost = 'h2';
    await expect(runProvision(inlineCtx(), ops, 'd1', input)).resolves.toMatchObject({ hostId: 'h2' });
    expect(ops.provision).toHaveBeenNthCalledWith(1, 'd1', input);
    expect(ops.provision).toHaveBeenNthCalledWith(2, 'd1', input);
  });

  it('names the journaled step with the idempotency token', async () => {
    const ops = fakeOps();
    const run = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
    const ctx = inlineCtx(run);
    await runStop(ctx, ops, 'd1', { callerId: 'u1' });
    await runResume(ctx, ops, 'd1', { callerId: 'u1' });
    await runBranch(ctx, ops, 'd1', { callerId: 'u1', targetId: 't1' });
    expect(run).toHaveBeenNthCalledWith(1, 'd1:stop', expect.any(Function));
    expect(run).toHaveBeenNthCalledWith(2, 'd1:resume', expect.any(Function));
    expect(run).toHaveBeenNthCalledWith(3, 'd1:branch', expect.any(Function));
  });

  it('performs no side effect when the journaled step is replayed', async () => {
    const ops = fakeOps();
    const replayed = { run: vi.fn().mockResolvedValue('journaled') } as unknown as ObjectContext;
    await expect(runStop(replayed, ops, 'd1', { callerId: 'u1' })).resolves.toBe('journaled');
    expect(ops.stop).not.toHaveBeenCalled();
  });

  it('branches with the caller target id for idempotency', async () => {
    const ops = fakeOps();
    const input = { callerId: 'u1', targetId: 't1' };
    await runBranch(inlineCtx(), ops, 'd1', input);
    expect(ops.branch).toHaveBeenCalledWith('d1', 't1', input);
  });

  it('expires TTL via durable sleep then stop through the dock object', async () => {
    const ops = fakeOps();
    const stop = vi.fn().mockResolvedValue({ id: 'd1', state: 'archived' });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const objectClient = vi.fn().mockReturnValue({ stop });
    const ctx = { run: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()), sleep, objectClient } as unknown as WorkflowContext;
    await expect(runTtl(ctx, ops, { dockId: 'd1', ttlSeconds: 60, callerId: 'u1' })).resolves.toEqual({
      dockId: 'd1',
      stopped: true,
    });
    expect(sleep).toHaveBeenCalledWith(60000, 'ttl-d1');
    expect(ops.sleepForTtl).toHaveBeenCalledWith('d1', 60);
    expect(objectClient).toHaveBeenCalledWith(dockObject, 'd1');
    expect(stop).toHaveBeenCalledWith({ callerId: 'u1' });
  });
});

describe('buildRuntimeOps', () => {
  const port = (): DocksPort & Record<'create' | 'stop' | 'resume' | 'branch', Mock> => ({
    create: vi.fn().mockResolvedValue({ id: 'd1' }),
    stop: vi.fn().mockResolvedValue({ id: 'd1', state: 'archived' }),
    resume: vi.fn().mockResolvedValue({ id: 'd1', state: 'ready' }),
    branch: vi.fn().mockResolvedValue({ id: 'd2' }),
  });

  it('provisions through create defaulting the key to the workflow token', async () => {
    const docks = port();
    const ops = buildRuntimeOps(docks);
    await ops.provision('d1', { callerId: 'u1', create: { workspaceId: 'w1' } });
    expect(docks.create).toHaveBeenCalledWith('u1', { workspaceId: 'w1' }, 'd1:provision');
  });

  it('passes caller idempotency keys through untouched', async () => {
    const docks = port();
    const ops = buildRuntimeOps(docks);
    await ops.provision('d1', { callerId: 'u1', create: { workspaceId: 'w1' }, idempotencyKey: 'k1' });
    await ops.branch('d1', 't1', { callerId: 'u1', targetId: 't1' });
    await ops.branch('d1', 't1', { callerId: 'u1', targetId: 't1', idempotencyKey: 'k2' });
    expect(docks.create).toHaveBeenCalledWith('u1', { workspaceId: 'w1' }, 'k1');
    expect(docks.branch).toHaveBeenNthCalledWith(1, 'u1', 'd1', {}, 't1');
    expect(docks.branch).toHaveBeenNthCalledWith(2, 'u1', 'd1', {}, 'k2');
  });

  it('stops and resumes with the caller identity', async () => {
    const docks = port();
    const ops = buildRuntimeOps(docks);
    await ops.stop('d1', { callerId: 'u1', force: true });
    await ops.resume('d1', { callerId: 'u1', patch: { cpus: 4 } });
    expect(docks.stop).toHaveBeenCalledWith('u1', 'd1', { force: true });
    expect(docks.resume).toHaveBeenCalledWith('u1', 'd1', { cpus: 4 });
  });

  it('leaves the TTL wait to ctx.sleep and resolves the intent marker', async () => {
    await expect(buildRuntimeOps(port()).sleepForTtl('d1', 60)).resolves.toBeUndefined();
  });
});

describe('runtime ops registry', () => {
  it('requires bootstrap before handlers resolve ops', () => {
    expect(() => getRuntimeOps()).toThrow('RuntimeOps not initialized');
    const ops = fakeOps();
    setRuntimeOps(ops);
    expect(getRuntimeOps()).toBe(ops);
  });

  it('registers the dock object and TTL workflow services', () => {
    expect(dockObject).toBeDefined();
    expect(dockTtlWorkflow).toBeDefined();
  });
});
