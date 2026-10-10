import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { count, eq } from 'drizzle-orm';
import { arch, platform } from 'node:os';
import { readApiVersion } from '../common/openapi-document';
import { DB, Db } from '../database/database.module';
import { docks, hosts } from '../database/schema';

const FIRST_REPORT_DELAY_MS = 60_000;
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

/** The complete payload; every field is documented in the telemetry docs page. */
export interface TelemetryPayload {
  version: string;
  os: string;
  arch: string;
  hosts: number;
  docks: number;
  runningDocks: number;
}

/** Opt-in anonymous usage counts; sends nothing unless DOCK_TELEMETRY=on. */
@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryService.name);
  private first?: NodeJS.Timeout;
  private daily?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('DOCK_TELEMETRY') !== 'on') return;
    this.first = setTimeout(() => void this.report(), FIRST_REPORT_DELAY_MS);
    this.first.unref();
    this.daily = setInterval(() => void this.report(), REPORT_INTERVAL_MS);
    this.daily.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.daily);
  }

  async payload(): Promise<TelemetryPayload> {
    const [[h], [d], [r]] = await Promise.all([
      this.db.select({ n: count() }).from(hosts),
      this.db.select({ n: count() }).from(docks),
      this.db.select({ n: count() }).from(docks).where(eq(docks.state, 'running')),
    ]);
    return {
      version: readApiVersion(),
      os: platform(),
      arch: arch(),
      hosts: h.n,
      docks: d.n,
      runningDocks: r.n,
    };
  }

  /** Sends one report; any failure is logged at debug and ignored. */
  async report(): Promise<void> {
    try {
      const url = this.config.get<string>('DOCK_TELEMETRY_URL') ?? '';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await this.payload()),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) this.logger.debug(`telemetry endpoint returned ${res.status}`);
    } catch (err) {
      this.logger.debug(`telemetry report failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}
