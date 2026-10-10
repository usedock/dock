import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, Db } from '../database/database.module';
import { dockStats, type DockStat, type DockStatContainer } from '../database/schema/dock-stats';
import { REDIS } from '../redis/redis.module';

/** Raw history retention in days; rollups stay a later change. */
export const RAW_RETENTION_DAYS = 7;
const HOT_TTL_SECONDS = 90;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_FIRST_RUN_MS = 30_000;
const WINDOW_SECONDS = { '1h': 3600, '24h': 86400 } as const;

export type StatsWindow = keyof typeof WINDOW_SECONDS;

export interface RecordStatsInput {
  cpuPercent: number;
  memBytes: number;
  memLimit?: number;
  diskBytes: number;
  rxBytes: number;
  txBytes: number;
  containers?: DockStatContainer[] | null;
  source?: string;
  at?: Date;
}

export interface StatSample {
  dockId: string;
  at: Date;
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  diskBytes: number;
  rxBytes: number;
  txBytes: number;
  source: string;
  containers?: DockStatContainer[];
}

export interface StatsMetrics {
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  diskBytes: number;
  rxBytes: number;
  txBytes: number;
}

export interface StatsAggregate {
  window: StatsWindow;
  samples: number;
  avg: StatsMetrics;
  peak: StatsMetrics;
}

export const hotKey = (dockId: string): string => `stats:dock:${dockId}`;

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

function num(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function zeroMetrics(): StatsMetrics {
  return { cpuPercent: 0, memBytes: 0, memLimit: 0, diskBytes: 0, rxBytes: 0, txBytes: 0 };
}

/** DB row to API view; containers stay absent when the dock reported none. */
function toSample(row: DockStat): StatSample {
  return {
    dockId: row.dockId,
    at: row.at,
    cpuPercent: row.cpuPercent,
    memBytes: row.memBytes,
    memLimit: row.memLimit,
    diskBytes: row.diskBytes,
    rxBytes: row.rxBytes,
    txBytes: row.txBytes,
    source: row.source,
    ...(row.containers ? { containers: row.containers } : {}),
  };
}

/**
 * Host-truth stats: Redis holds the hot sample, Postgres the history.
 * Hot misses fall back to the latest row; empty docks read null, never 404.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  private purgeTimer?: NodeJS.Timeout;
  private firstPurge?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  checkedWindow(value: unknown): StatsWindow {
    if (value === '1h' || value === '24h') return value;
    throw validationError('window must be 1h or 24h');
  }

  async record(dockId: string, input: RecordStatsInput): Promise<StatSample> {
    const [row] = await this.db
      .insert(dockStats)
      .values({
        dockId,
        at: input.at ?? new Date(),
        cpuPercent: input.cpuPercent,
        memBytes: input.memBytes,
        memLimit: input.memLimit ?? 0,
        diskBytes: input.diskBytes,
        rxBytes: input.rxBytes,
        txBytes: input.txBytes,
        containers: input.containers ?? null,
        source: input.source ?? 'host',
      })
      .returning();
    const sample = toSample(row);
    try {
      await this.redis.set(hotKey(dockId), JSON.stringify({ ...sample, at: sample.at.toISOString() }), 'EX', HOT_TTL_SECONDS);
    } catch {
      // Hot cache is best-effort; history already persisted.
    }
    return sample;
  }

  async current(dockId: string): Promise<StatSample | null> {
    try {
      const raw = await this.redis.get(hotKey(dockId));
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const at = parsed['at'];
        if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) {
          const containers = Array.isArray(parsed['containers'])
            ? (parsed['containers'] as DockStatContainer[])
            : undefined;
          const source = parsed['source'];
          return {
            dockId,
            at: new Date(at),
            cpuPercent: num(parsed['cpuPercent'] as string | number | null | undefined),
            memBytes: num(parsed['memBytes'] as string | number | null | undefined),
            memLimit: num(parsed['memLimit'] as string | number | null | undefined),
            diskBytes: num(parsed['diskBytes'] as string | number | null | undefined),
            rxBytes: num(parsed['rxBytes'] as string | number | null | undefined),
            txBytes: num(parsed['txBytes'] as string | number | null | undefined),
            source: typeof source === 'string' ? source : 'host',
            ...(containers ? { containers } : {}),
          };
        }
      }
    } catch {
      // Corrupt or unreachable hot cache falls through to Postgres.
    }
    const [row] = await this.db
      .select()
      .from(dockStats)
      .where(eq(dockStats.dockId, dockId))
      .orderBy(desc(dockStats.at))
      .limit(1);
    return row ? toSample(row) : null;
  }

  async window(dockId: string, w: StatsWindow): Promise<StatsAggregate> {
    const window = this.checkedWindow(w);
    const since = new Date(Date.now() - WINDOW_SECONDS[window] * 1000);
    const [row] = await this.db
      .select({
        samples: sql<number>`count(*)::int`,
        avgCpu: sql<string | number | null>`avg(${dockStats.cpuPercent})`,
        maxCpu: sql<string | number | null>`max(${dockStats.cpuPercent})`,
        avgMem: sql<string | number | null>`avg(${dockStats.memBytes})`,
        maxMem: sql<string | number | null>`max(${dockStats.memBytes})`,
        avgMemLimit: sql<string | number | null>`avg(${dockStats.memLimit})`,
        maxMemLimit: sql<string | number | null>`max(${dockStats.memLimit})`,
        avgDisk: sql<string | number | null>`avg(${dockStats.diskBytes})`,
        maxDisk: sql<string | number | null>`max(${dockStats.diskBytes})`,
        avgRx: sql<string | number | null>`avg(${dockStats.rxBytes})`,
        maxRx: sql<string | number | null>`max(${dockStats.rxBytes})`,
        avgTx: sql<string | number | null>`avg(${dockStats.txBytes})`,
        maxTx: sql<string | number | null>`max(${dockStats.txBytes})`,
      })
      .from(dockStats)
      .where(and(eq(dockStats.dockId, dockId), gte(dockStats.at, since)));
    const samples = num(row?.samples);
    if (!row || samples === 0) return { window, samples: 0, avg: zeroMetrics(), peak: zeroMetrics() };
    return {
      window,
      samples,
      avg: {
        cpuPercent: num(row.avgCpu),
        memBytes: num(row.avgMem),
        memLimit: num(row.avgMemLimit),
        diskBytes: num(row.avgDisk),
        rxBytes: num(row.avgRx),
        txBytes: num(row.avgTx),
      },
      peak: {
        cpuPercent: num(row.maxCpu),
        memBytes: num(row.maxMem),
        memLimit: num(row.maxMemLimit),
        diskBytes: num(row.maxDisk),
        rxBytes: num(row.maxRx),
        txBytes: num(row.maxTx),
      },
    };
  }

  async purge(olderThanDays: number = RAW_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400 * 1000);
    const rows = await this.db.delete(dockStats).where(lt(dockStats.at, cutoff)).returning({ id: dockStats.id });
    return rows.length;
  }

  onModuleInit(): void {
    const run = () => void this.purge().catch((err) => this.logger.warn(`Stats purge failed: ${(err as Error).message}`));
    this.firstPurge = setTimeout(run, PURGE_FIRST_RUN_MS);
    this.firstPurge.unref();
    this.purgeTimer = setInterval(run, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.firstPurge) clearTimeout(this.firstPurge);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }
}
