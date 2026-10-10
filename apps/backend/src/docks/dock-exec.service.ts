import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { hashToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { githubRuns, type Dock, type DockState } from '../database/schema';
import { assertEnvKey } from '../environments/env-validation';
import { deadlineFromConfig } from '../fleet/host-command-queue';
import { REDIS } from '../redis/redis.module';
import { COMPUTE_PROVIDER, type ComputeProvider } from './compute.provider';
import { DockNotRunningException, ExecFailedException, ExecResultExpiredException, ExecRateLimitedException, ExecTimeoutException, ExecUnavailableException } from './dock-errors';
import { DocksService } from './docks.service';
import type { DockExecResultDto, ExecDockDto } from './dto/exec-dock.dto';

export const EXEC_STATES: DockState[] = ['ready', 'idle', 'running'];
export const EXEC_DEFAULT_TIMEOUT_SECONDS = 60;
export const EXEC_MAX_OUTPUT_BYTES = 1 << 20;
const EXEC_MAX_TIMEOUT_SECONDS = 600;
/** Host dispatch and result posting must fit in the fleet budget beside the script. */
const EXEC_DISPATCH_SLACK_SECONDS = 60;
const EXEC_MAX_COMMAND_BYTES = 65536;
const EXEC_MAX_ENV_KEYS = 64;
const EXEC_MAX_ENV_BYTES = 32768;
const EXEC_PER_DOCK_INFLIGHT = 4;
const EXEC_DOCK_RATE = { limit: 120, windowSeconds: 60 };
const EXEC_CALLER_RATE = { limit: 600, windowSeconds: 60 };
const WORK_DIR = '/home/user/work';

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

/** POSIX single-quote escaping for one shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clipBytes(value: string): { text: string; clipped: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= EXEC_MAX_OUTPUT_BYTES) return { text: value, clipped: false };
  return { text: bytes.subarray(0, EXEC_MAX_OUTPUT_BYTES).toString('utf8'), clipped: true };
}

/**
 * Public command execution through the dock's guest exec agent. Commands and
 * env values are never logged; results are bounded to 1 MiB per stream.
 */
@Injectable()
export class DockExecService {
  private readonly logger = new Logger(DockExecService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
    private readonly limits: RateLimitService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  /** Longest timeoutSeconds this deployment can honor end to end. */
  timeoutCeiling(): number {
    const budget = Math.floor(deadlineFromConfig('fast-run.exec', (key) => this.config.get<string>(key)) / 1000);
    return Math.max(1, Math.min(EXEC_MAX_TIMEOUT_SECONDS, budget - EXEC_DISPATCH_SLACK_SECONDS));
  }

  async exec(callerId: string, id: string, input: ExecDockDto, idempotencyKey?: string): Promise<DockExecResultDto> {
    const timeoutSeconds = input.timeoutSeconds ?? EXEC_DEFAULT_TIMEOUT_SECONDS;
    const ceiling = this.timeoutCeiling();
    if (timeoutSeconds > ceiling) throw validationError(`timeoutSeconds must be at most ${ceiling} on this deployment`);
    if (Buffer.byteLength(input.command, 'utf8') > EXEC_MAX_COMMAND_BYTES) throw validationError('command must be at most 64KB');
    const env = this.checkedEnv(input.env);
    if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 255)) {
      throw validationError('Idempotency-Key must be 1-255 characters');
    }
    const dock = await this.loadExecutableDock(callerId, id);
    await this.hit(`rl:exec:dock:${dock.id}`, EXEC_DOCK_RATE);
    await this.hit(`rl:exec:caller:${callerId}`, EXEC_CALLER_RATE);
    const inflight = `exec:inflight:${dock.id}`;
    await this.claimSlot(inflight, timeoutSeconds);
    const script = `cd -- ${shellQuote(input.cwd ?? WORK_DIR)} || exit 1\n${input.command}`;
    const token = idempotencyKey ? `exec:${dock.id}:${hashToken(idempotencyKey)}` : `exec:${dock.id}:${randomUUID()}`;
    const started = Date.now();
    try {
      const outcome = await this.provider.exec(dock, { script, timeoutSeconds, env, idempotencyToken: token });
      const durationMs = Date.now() - started;
      // Older agents report a timeout only as exit 124 after the full budget.
      if (outcome.timedOut || (outcome.exitCode === 124 && durationMs >= timeoutSeconds * 1000)) {
        throw new ExecTimeoutException(timeoutSeconds);
      }
      const stdout = clipBytes(outcome.stdout);
      const stderr = clipBytes(outcome.stderr);
      return {
        exitCode: outcome.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs,
        truncated: outcome.truncated || stdout.clipped || stderr.clipped,
      };
    } catch (err) {
      throw this.mapError(err, dock.id, timeoutSeconds);
    } finally {
      await this.redis.decr(inflight).catch(() => undefined);
    }
  }

  /** A dock the caller may run commands in: live, metered, and not driven by a run. */
  async loadExecutableDock(callerId: string, id: string): Promise<Dock> {
    const { dock } = await this.docks.loadReadableDock(callerId, id);
    if (!EXEC_STATES.includes(dock.state)) throw new DockNotRunningException(dock.state);
    if (dock.billingPausedAt) throw new DockNotRunningException('paused after a refused stop');
    if (await this.isRunDock(dock.id)) {
      throw new ExecUnavailableException('This dock is driven by a run; branch it to run commands');
    }
    return dock;
  }

  private checkedEnv(env: unknown): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) throw validationError('env must be a string map');
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > EXEC_MAX_ENV_KEYS) throw validationError(`env holds at most ${EXEC_MAX_ENV_KEYS} variables`);
    for (const [key, value] of entries) {
      assertEnvKey(key);
      if (typeof value !== 'string') throw validationError(`env ${key} must be a string`);
    }
    const record = Object.fromEntries(entries) as Record<string, string>;
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > EXEC_MAX_ENV_BYTES) throw validationError('env totals at most 32KB');
    return record;
  }

  /** Run docks carry run credentials in their runner; only the run drives them. */
  private async isRunDock(dockId: string): Promise<boolean> {
    const rows = await this.db.select({ id: githubRuns.id }).from(githubRuns).where(eq(githubRuns.dockId, dockId)).limit(1);
    return rows.length > 0;
  }

  private async hit(key: string, rate: { limit: number; windowSeconds: number }): Promise<void> {
    const { allowed } = await this.limits.hit(key, rate.limit, rate.windowSeconds);
    if (!allowed) throw new ExecRateLimitedException();
  }

  /** Bounds concurrent commands per dock; the TTL frees slots a crashed request never released. */
  private async claimSlot(key: string, timeoutSeconds: number): Promise<void> {
    let count: number;
    try {
      count = await this.redis.incr(key);
      await this.redis.expire(key, timeoutSeconds + EXEC_DISPATCH_SLACK_SECONDS * 2);
    } catch (err) {
      throw new ExecFailedException('exec_failed', `Exec limiter unavailable: ${(err as Error).message}`);
    }
    if (count > EXEC_PER_DOCK_INFLIGHT) {
      await this.redis.decr(key).catch(() => undefined);
      throw new ExecRateLimitedException();
    }
  }

  private mapError(err: unknown, dockId: string, timeoutSeconds: number): unknown {
    if (err instanceof ExecTimeoutException) return err;
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
    const message = err instanceof Error ? err.message : '';
    // Docklets predating exec_unavailable report a missing agent as a host_error.
    if (code === 'exec_unavailable' || /fast runtime \S+ not found/.test(message)) return new ExecUnavailableException();
    if (code === 'result_not_retained') return new ExecResultExpiredException();
    if (code === 'host_busy') return new ExecFailedException('exec_busy', 'The dock host is running too many commands; retry shortly');
    if (code === 'host_timeout') return new ExecTimeoutException(timeoutSeconds);
    this.logger.warn(`Exec on dock ${dockId} failed: ${code || 'error'}`);
    return new ExecFailedException('exec_failed', 'The dock host could not run the command');
  }
}
