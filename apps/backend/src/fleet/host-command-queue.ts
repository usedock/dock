import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { and, asc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { hostCommands, hostGenerations, hosts, snapshots, templates } from '../database/schema';

/** Fleet ops the control plane can queue for a host; see local contract doc. */
export const FLEET_OPS = [
  'provision',
  'pause',
  'snapshot.create',
  'snapshot.load',
  'destroy',
  'fast-run.create',
  'fast-run.exec',
  'fast-run.read',
  'fast-run.terminate',
  'status',
  'stats',
  'generation.tree',
  'generation.file',
  'terminal.open',
  'tunnel.open',
] as const;
export type FleetOp = (typeof FLEET_OPS)[number];

export interface HostCommandPayload {
  id: string;
  op: FleetOp;
  idempotencyToken: string;
  deadlineMs: number;
  payload: Record<string, unknown>;
}

export class CommandTimeoutException extends Error {
  readonly code = 'host_timeout';
  constructor(readonly op: string) {
    super(`Host did not return a result for ${op}`);
  }
}

export class CommandFailedException extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HostMismatchException extends ForbiddenException {
  constructor() {
    super({ code: 'host_mismatch', message: 'Command is assigned to a different host' });
  }
}

/**
 * Result budget per op, in milliseconds, overridable per operation via
 * `FLEET_TIMEOUT_<OP>_MS` (dots become underscores, upper-cased).
 *
 * Sized from measured work, not guessed: a capture reads the dock's changed
 * blocks and uploads them through the control plane, whose throughput is the
 * real constraint. An explicit budget is what turns "the API timed out and we
 * never learned why" into a named `host_timeout` the caller can act on.
 */
const DEFAULT_DEADLINES_MS: Record<string, number> = {
  // Reads: a host answers these from local state.
  status: 30_000,
  stats: 30_000,
  'generation.tree': 30_000,
  'generation.file': 30_000,
  // Boot, freeze and restore do real disk and network work.
  provision: 300_000,
  pause: 30_000,
  destroy: 60_000,
  // A capture pauses the guest, diffs and compresses the rootfs, then uploads.
  // Allow substantially longer than a boot; the object proxy is the bottleneck.
  'snapshot.create': 900_000,
  'snapshot.load': 600_000,
  // Ephemeral runs are script-sized.
  'fast-run.create': 120_000,
  'fast-run.exec': 300_000,
  'fast-run.read': 60_000,
  'fast-run.terminate': 60_000,
  // The host answers once the guest shell and its relay connection are up.
  'terminal.open': 30_000,
  // A browser request waits on this, so a host that cannot connect fails fast.
  'tunnel.open': 15_000,
};

/** Result budget for one op, honoring the per-op env override. */
export function deadlineFromConfig(op: FleetOp, lookup: (key: string) => string | undefined): number {
  const override = Number(lookup(`FLEET_TIMEOUT_${op.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MS`) ?? '');
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_DEADLINES_MS[op] ?? 300_000;
}

/** How long a claimed command may stay claimed before it is re-queued. */
const CLAIM_TTL_MS = 60_000;

/** Slack past a command's own deadline before its claim counts as abandoned. */
const CLAIM_DEADLINE_MARGIN_MS = 30_000;

/** Pickup granularity: how often a waiting poll re-checks for new work. */
const POLL_INTERVAL_MS = 250;

/** Guest scripts and shells are not safe to replay, so their stale claims are failed instead of re-queued. */
const AT_MOST_ONCE_OPS: FleetOp[] = ['fast-run.exec', 'terminal.open', 'tunnel.open'];

/** Past its deadline the awaiter has already timed out; the grace lets it do so before the row is failed. */
const EXPIRY_GRACE_MS = CLAIM_TTL_MS;

/** How often the global expiry and old-row sweep runs. */
const SWEEP_INTERVAL_MS = 60_000;

/** Completed commands are retained briefly so retried steps can read results. */
const COMPLETED_TTL_MS = 15 * 60_000;

/**
 * Outbound fleet control: the control plane queues host operations and docklets
 * long-poll for them. Hosts never listen for inbound traffic, so a sandbox
 * machine needs no public port and no per-host firewall rule.
 *
 * Durable decisions stay in Postgres; the long poll is only a delivery
 * mechanism, so a host restart simply resumes polling.
 */
@Injectable()
export class HostCommandQueue {
  private readonly logger = new Logger(HostCommandQueue.name);

  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(
      () => void this.sweepAll().catch((err) => this.logger.warn(`Command sweep failed: ${(err as Error).message}`)),
      SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Fails queued commands nobody can still await and deletes old finished rows, for every host. */
  async sweepAll(): Promise<void> {
    await this.db
      .update(hostCommands)
      .set({ state: 'failed', errorCode: 'host_timeout', errorMessage: 'Command expired before a host picked it up', completedAt: new Date() })
      .where(
        and(
          eq(hostCommands.state, 'queued'),
          sql`${hostCommands.createdAt} + (${hostCommands.deadlineMs} + ${EXPIRY_GRACE_MS}) * interval '1 millisecond' < now()`,
        ),
      );
    await this.db
      .delete(hostCommands)
      .where(and(inArray(hostCommands.state, ['done', 'failed']), lt(hostCommands.completedAt, new Date(Date.now() - COMPLETED_TTL_MS))));
  }

  /** Enrollment-only gate: the shared token authorizes enroll and register, nothing else. */
  assertToken(token: string | undefined): void {
    if (!this.isEnrollToken(token)) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid fleet token' });
    }
  }

  /** Fail closed: without a configured token nothing matches. */
  isEnrollToken(token: string | undefined): boolean {
    const expected = this.config.get<string>('FLEET_TOKEN') ?? '';
    return Boolean(expected && token && constantTimeEquals(token, expected));
  }

  /**
   * Resolves the calling host from its per-host credential; the hostId is never
   * taken from the request. Transition only (FLEET_LEGACY_SHARED_TOKEN=true):
   * the shared token may act as a host that has no credential yet, named by
   * `claimedHostId`.
   */
  async authenticateHost(token: string | undefined, claimedHostId?: string): Promise<string> {
    if (token && claimedHostId && this.config.get<string>('FLEET_LEGACY_SHARED_TOKEN') === 'true' && this.isEnrollToken(token)) {
      const [legacy] = await this.db.select({ id: hosts.id }).from(hosts).where(and(eq(hosts.id, claimedHostId), isNull(hosts.credentialHash))).limit(1);
      if (legacy) return legacy.id;
    }
    if (token) {
      const hash = hashCredential(token);
      const [row] = await this.db.select({ id: hosts.id, hash: hosts.credentialHash }).from(hosts).where(eq(hosts.credentialHash, hash)).limit(1);
      if (row?.hash && constantTimeEquals(row.hash, hash)) return row.id;
    }
    throw new UnauthorizedException({ code: 'host_credential_unknown', message: 'Unknown host credential; register again' });
  }

  /**
   * Claims the next command for a host, waiting up to waitSeconds for one to
   * appear. A stale claim is reclaimed so a crashed host cannot strand work.
   */
  async poll(hostId: string, waitSeconds: number): Promise<HostCommandPayload | null> {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    await this.requeueStaleClaims(hostId);
    for (;;) {
      const claimed = await this.claimNext(hostId);
      if (claimed) return claimed;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  /**
   * Releases expired claims and prunes completed rows, so a host that died
   * mid-command is retried instead of leaving the caller waiting forever.
   */
  private async requeueStaleClaims(hostId: string): Promise<void> {
    const cutoff = new Date(Date.now() - CLAIM_TTL_MS);
    // Lifecycle ops keep running while the host polls on: stale only past max(TTL, deadline + margin), which is always past the
    // deadline. The caller gave up and random-token ops have no retrier, so replaying would only run stale work; same-token retries re-queue the failed row.
    await this.db
      .update(hostCommands)
      .set({ state: 'failed', errorCode: 'host_timeout', errorMessage: 'Host never reported the result before the deadline', completedAt: new Date() })
      .where(
        and(
          eq(hostCommands.hostId, hostId),
          eq(hostCommands.state, 'claimed'),
          notInArray(hostCommands.op, AT_MOST_ONCE_OPS),
          sql`${hostCommands.claimedAt} < ${cutoff}::timestamptz - (greatest(0, ${hostCommands.deadlineMs} + ${CLAIM_DEADLINE_MARGIN_MS} - ${CLAIM_TTL_MS}) * interval '1 millisecond')`,
        ),
      );
    const pruneCutoff = new Date(Date.now() - COMPLETED_TTL_MS);
    // A host that died mid-exec never reports; its claim is failed, never replayed.
    await this.db
      .update(hostCommands)
      .set({ state: 'failed', errorCode: 'host_timeout', errorMessage: 'Host never reported the result', completedAt: new Date() })
      .where(
        and(
          eq(hostCommands.hostId, hostId),
          eq(hostCommands.state, 'claimed'),
          inArray(hostCommands.op, AT_MOST_ONCE_OPS),
          lt(hostCommands.claimedAt, pruneCutoff),
        ),
      );
    await this.db
      .delete(hostCommands)
      .where(
        and(
          eq(hostCommands.hostId, hostId),
          inArray(hostCommands.state, ['done', 'failed']),
          lt(hostCommands.completedAt, pruneCutoff),
        ),
      );
    // A binding outlives its command only as dead weight: pruned with it.
    await this.db
      .delete(hostGenerations)
      .where(and(eq(hostGenerations.hostId, hostId), sql`not exists (select 1 from ${hostCommands} where ${hostCommands.id} = ${hostGenerations.commandId})`));
  }

  private async claimNext(hostId: string): Promise<HostCommandPayload | null> {
    const [next] = await this.db
      .select()
      .from(hostCommands)
      .where(and(eq(hostCommands.hostId, hostId), eq(hostCommands.state, 'queued')))
      .orderBy(asc(hostCommands.createdAt))
      .limit(1);
    if (!next) return null;
    const [claimed] = await this.db
      .update(hostCommands)
      .set({ state: 'claimed', claimedAt: new Date() })
      .where(and(eq(hostCommands.id, next.id), eq(hostCommands.state, 'queued')))
      .returning();
    // Lost the race to another poller: let the next loop try the following row.
    if (!claimed) return null;
    return {
      id: claimed.id,
      op: claimed.op as FleetOp,
      idempotencyToken: claimed.idempotencyToken,
      deadlineMs: claimed.deadlineMs,
      payload: claimed.payload,
    };
  }

  /**
   * Records one host's result. A result for another host's command is refused
   * so a misconfigured agent cannot complete work it did not run.
   */
  async recordResult(
    hostId: string,
    commandId: string,
    input: { ok: boolean; data?: unknown; code?: string; message?: string },
  ): Promise<{ accepted: boolean }> {
    const [command] = await this.db.select().from(hostCommands).where(eq(hostCommands.id, commandId)).limit(1);
    if (!command) throw new NotFoundException({ code: 'command_not_found', message: `Unknown command ${commandId}` });
    if (command.hostId !== hostId) throw new HostMismatchException();
    // A retried post must not rewrite an outcome the awaiter may already have consumed.
    if (command.state === 'done' || command.state === 'failed') {
      this.logger.warn(`Ignored result retry for finished command ${commandId} from host ${hostId}`);
      return { accepted: true };
    }
    if (command.op === 'snapshot.create' && input.ok) await this.assertCaptureResult(command.id, input.data);
    // Only a still-claimed command takes an outcome, so a racing post or one after the stale-claim sweep cannot rewrite it.
    const recorded = await this.db
      .update(hostCommands)
      .set({
        state: input.ok ? 'done' : 'failed',
        result: input.data ?? null,
        errorCode: input.ok ? null : (input.code ?? 'host_error'),
        errorMessage: input.ok ? null : (input.message ?? 'Host reported failure'),
        completedAt: new Date(),
      })
      .where(and(eq(hostCommands.id, commandId), eq(hostCommands.state, 'claimed')))
      .returning({ id: hostCommands.id });
    if (recorded.length === 0) this.logger.warn(`Ignored result for command ${commandId} from host ${hostId}: no longer claimed`);
    return { accepted: true };
  }

  /**
   * A capture may only report the generation it bound by writing: ids the host
   * made up, or ones already recorded for a snapshot or template, are refused
   * and the command fails instead of recording a foreign generation.
   */
  private async assertCaptureResult(commandId: string, data: unknown): Promise<void> {
    const snapshotId = (data as { snapshotId?: unknown } | null | undefined)?.snapshotId;
    const [bound] = typeof snapshotId === 'string'
      ? await this.db.select({ commandId: hostGenerations.commandId }).from(hostGenerations).where(eq(hostGenerations.generationId, snapshotId)).limit(1)
      : [];
    const [snap] = bound ? await this.db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.storeSnapshotId, snapshotId as string)).limit(1) : [];
    const [tpl] = bound && !snap ? await this.db.select({ id: templates.id }).from(templates).where(eq(templates.storeSnapshotId, snapshotId as string)).limit(1) : [];
    if (bound?.commandId === commandId && !snap && !tpl) return;
    await this.db
      .update(hostCommands)
      .set({ state: 'failed', errorCode: 'generation_rejected', errorMessage: 'Capture reported a generation it did not write', completedAt: new Date() })
      .where(and(eq(hostCommands.id, commandId), eq(hostCommands.state, 'claimed')));
    throw new ForbiddenException({ code: 'generation_rejected', message: 'Capture reported a generation it did not write' });
  }

  /**
   * Queues one operation and awaits its result. Retrying with the same token
   * attaches to the existing command, so a replayed workflow step never runs
   * the operation twice.
   */
  async execute<T>(
    hostId: string,
    op: FleetOp,
    payload: Record<string, unknown>,
    idempotencyToken: string,
  ): Promise<T> {
    const command = await this.enqueue(hostId, op, payload, idempotencyToken);
    return this.awaitResult<T>(command);
  }

  private async enqueue(
    hostId: string,
    op: FleetOp,
    payload: Record<string, unknown>,
    idempotencyToken: string,
  ): Promise<{ id: string; deadlineMs: number }> {
    await this.db
      .insert(hostCommands)
      .values({
        id: randomUUID(),
        hostId,
        op,
        payload,
        idempotencyToken,
        deadlineMs: deadlineFromConfig(op, (key) => this.config.get<string>(key)),
        state: 'queued',
      })
      .onConflictDoNothing({ target: [hostCommands.hostId, hostCommands.idempotencyToken] });
    const [existing] = await this.db
      .select()
      .from(hostCommands)
      .where(and(eq(hostCommands.hostId, hostId), eq(hostCommands.idempotencyToken, idempotencyToken)))
      .limit(1);
    if (!existing) throw new Error(`Command ${idempotencyToken} missing after enqueue`);
    // A previous attempt failed; the retry is a fresh delivery of the same
    // operation, so the row is re-queued with a fresh deadline clock rather than left terminal.
    if (existing.state === 'failed') {
      await this.db
        .update(hostCommands)
        .set({ state: 'queued', createdAt: new Date(), claimedAt: null, completedAt: null, errorCode: null, errorMessage: null, result: null })
        .where(eq(hostCommands.id, existing.id));
    }
    return { id: existing.id, deadlineMs: existing.deadlineMs };
  }

  /** Waits for the host to post a result, failing closed on timeout. */
  private async awaitResult<T>(command: { id: string; deadlineMs: number }): Promise<T> {
    const deadline = Date.now() + command.deadlineMs;
    for (;;) {
      const [row] = await this.db.select().from(hostCommands).where(eq(hostCommands.id, command.id)).limit(1);
      if (!row) throw new CommandFailedException('command_not_found', `Command ${command.id} disappeared`);
      if (row.state === 'done') return row.result as T;
      if (row.state === 'failed') throw new CommandFailedException(row.errorCode ?? 'host_error', row.errorMessage ?? 'Host reported failure');
      if (Date.now() >= deadline) throw new CommandTimeoutException(row.op);
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
  }

}

/** Only this digest is stored, so a database read never yields a usable credential. */
export function hashCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

/** The legacy X-Host-Id header is never authoritative: absent is fine, a value naming another host is refused. */
export function hostIdHeaderAgrees(req: { headers: Record<string, string | string[] | undefined> }, authenticatedHostId: string): boolean {
  const header = req.headers['x-host-id'];
  return header === undefined || header === authenticatedHostId;
}

/** Extracts the bearer token; anything else is treated as absent. */
export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1].trim() : undefined;
}

/**
 * Length-independent comparison so a wrong token cannot be brute-forced by
 * timing. Hashing to a fixed digest first means `timingSafeEqual` never sees
 * (and so never leaks) the raw lengths of the two inputs.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
