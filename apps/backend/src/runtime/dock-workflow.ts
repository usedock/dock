import * as restate from '@restatedev/restate-sdk';
import type { ObjectContext, WorkflowContext } from '@restatedev/restate-sdk';
import type {
  BranchDockInput,
  CreateDockInput,
  ResumeDockInput,
  StopDockInput,
} from '../docks/docks.service';
import type { DockState } from '../database/schema';

/** Mirrors DocksService.RUNNABLE_STATES; that export stays the single source of truth. */
const RUNNABLE_STATES: readonly DockState[] = [
  'provisioning',
  'provisioned',
  'cloning',
  'ready',
  'idle',
  'running',
  'error',
  'unreachable',
];

/** Durable ops, one per lifecycle verb; names double as idempotency scopes. */
export type DockWorkflowOp = 'provision' | 'stop' | 'resume' | 'branch' | 'ttl';

/** Stable token per workflow key and op; replay reuses it, never re-executes. */
export function idempotencyTokenFor(workflowId: string, op: DockWorkflowOp): string {
  return `${workflowId}:${op}`;
}

/** Durable-timer name for the TTL sleep, stable across replays. */
export function ttlTimerName(dockId: string): string {
  return `ttl-${dockId}`;
}

/** TTL seconds converted to the ms ctx.sleep expects. */
export function ttlDelayMs(ttlSeconds: number): number {
  return ttlSeconds * 1000;
}

/** Mirrors DocksService.stop: archived/archiving short-circuit, runnable states proceed. */
export function canStopFrom(state: DockState): boolean {
  return state === 'archived' || state === 'archiving' || RUNNABLE_STATES.includes(state);
}

/** Mirrors DocksService.resume: only archived docks resume. */
export function canResumeFrom(state: DockState): boolean {
  return state === 'archived';
}

export interface DockProvisionInput {
  callerId: string;
  create: CreateDockInput;
  idempotencyKey?: string;
}

export interface DockStopInput {
  callerId: string;
  force?: boolean;
}

export interface DockResumeInput {
  callerId: string;
  patch?: ResumeDockInput;
}

export interface DockBranchInput {
  callerId: string;
  /** Caller-allocated request id; defaults the service idempotency key. */
  targetId: string;
  opts?: BranchDockInput;
  idempotencyKey?: string;
}

export interface DockTtlRequest {
  dockId: string;
  ttlSeconds: number;
  /** Scheduling caller, so expiry stop authorizes as the creator would. */
  callerId: string;
}

/** Side-effect port; every method runs inside ctx.run so replay never re-executes. */
export interface RuntimeOps {
  provision(dockId: string, input: DockProvisionInput): Promise<unknown>;
  stop(dockId: string, opts: DockStopInput): Promise<unknown>;
  resume(dockId: string, opts: DockResumeInput): Promise<unknown>;
  branch(sourceId: string, targetId: string, opts: DockBranchInput): Promise<unknown>;
  sleepForTtl(dockId: string, ttlSeconds: number): Promise<void>;
}

/** Structural slice of DocksService used by durable handlers. */
export interface DocksPort {
  create(callerId: string, input: CreateDockInput, idempotencyKey?: string): Promise<unknown>;
  stop(callerId: string, id: string, opts?: StopDockInput): Promise<unknown>;
  resume(callerId: string, id: string, opts?: ResumeDockInput): Promise<unknown>;
  branch(callerId: string, id: string, opts?: BranchDockInput, idempotencyKey?: string): Promise<unknown>;
}

/** Binds RuntimeOps to DocksService; real lifecycle logic stays in the service. */
export function buildRuntimeOps(docks: DocksPort): RuntimeOps {
  return {
    provision: (dockId, input) =>
      docks.create(input.callerId, input.create, input.idempotencyKey ?? idempotencyTokenFor(dockId, 'provision')),
    stop: (dockId, opts) => docks.stop(opts.callerId, dockId, { force: opts.force }),
    resume: (dockId, opts) => docks.resume(opts.callerId, dockId, opts.patch ?? {}),
    branch: (sourceId, targetId, opts) =>
      docks.branch(opts.callerId, sourceId, opts.opts ?? {}, opts.idempotencyKey ?? targetId),
    // Real wait is ctx.sleep in the TTL workflow; this journals TTL intent for replay stability.
    sleepForTtl: async () => undefined,
  };
}

let currentOps: RuntimeOps | undefined;

/** Bootstrap swaps in the DocksService-backed ops; tests inject fakes. */
export function setRuntimeOps(ops: RuntimeOps): void {
  currentOps = ops;
}

/** Handlers resolve ops at invocation time so bootstrap can swap them. */
export function getRuntimeOps(): RuntimeOps {
  if (!currentOps) throw new Error('RuntimeOps not initialized; bootstrap must call setRuntimeOps');
  return currentOps;
}

/** Provision delegate; the only side effect is the journaled ops call. */
export function runProvision(ctx: ObjectContext, ops: RuntimeOps, dockId: string, input: DockProvisionInput): Promise<unknown> {
  return ctx.run(idempotencyTokenFor(dockId, 'provision'), () => ops.provision(dockId, input));
}

/** Stop delegate; the only side effect is the journaled ops call. */
export function runStop(ctx: ObjectContext, ops: RuntimeOps, dockId: string, input: DockStopInput): Promise<unknown> {
  return ctx.run(idempotencyTokenFor(dockId, 'stop'), () => ops.stop(dockId, input));
}

/** Resume delegate; the only side effect is the journaled ops call. */
export function runResume(ctx: ObjectContext, ops: RuntimeOps, dockId: string, input: DockResumeInput): Promise<unknown> {
  return ctx.run(idempotencyTokenFor(dockId, 'resume'), () => ops.resume(dockId, input));
}

/** Branch delegate; the only side effect is the journaled ops call. */
export function runBranch(ctx: ObjectContext, ops: RuntimeOps, sourceId: string, input: DockBranchInput): Promise<unknown> {
  return ctx.run(idempotencyTokenFor(sourceId, 'branch'), () => ops.branch(sourceId, input.targetId, input));
}

/** Exclusive per-dock lifecycle object; the key is the dock id. */
export const dockObject = restate.object({
  name: 'dock',
  handlers: {
    provision: async (ctx: ObjectContext, input: DockProvisionInput) => runProvision(ctx, getRuntimeOps(), ctx.key, input),
    stop: async (ctx: ObjectContext, input: DockStopInput) => runStop(ctx, getRuntimeOps(), ctx.key, input),
    resume: async (ctx: ObjectContext, input: DockResumeInput) => runResume(ctx, getRuntimeOps(), ctx.key, input),
    branch: async (ctx: ObjectContext, input: DockBranchInput) => runBranch(ctx, getRuntimeOps(), ctx.key, input),
  },
});

/** TTL expiry: durable sleep, journaled intent, then stop through the dock object. */
export async function runTtl(
  ctx: WorkflowContext,
  ops: RuntimeOps,
  req: DockTtlRequest,
): Promise<{ dockId: string; stopped: boolean }> {
  await ctx.sleep(ttlDelayMs(req.ttlSeconds), ttlTimerName(req.dockId));
  await ctx.run(idempotencyTokenFor(req.dockId, 'ttl'), () => ops.sleepForTtl(req.dockId, req.ttlSeconds));
  await ctx.objectClient(dockObject, req.dockId).stop({ callerId: req.callerId });
  return { dockId: req.dockId, stopped: true };
}

/** TTL auto-stop workflow; keyed by dock id like the object it stops. */
export const dockTtlWorkflow = restate.workflow({
  name: 'dockTtl',
  handlers: {
    run: async (ctx: WorkflowContext, req: DockTtlRequest) => runTtl(ctx, getRuntimeOps(), req),
  },
});
