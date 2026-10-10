import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { HostsService, type RegisterHostInput } from '../hosts/hosts.service';
import { StatsService } from '../stats/stats.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { HostWorkload, Runtime } from '../database/schema';
import type { HostSampleDto } from './dto/fleet.dto';

const RUNTIMES = ['microvm', 'gvisor'] as const;

export interface RegisterResult {
  hostId: string;
  heartbeatSeconds: number;
  pollWaitSeconds: number;
  /** Per-host fleet credential; present only when registering with the enrollment token. */
  credential?: string;
}

export interface EnrollResult {
  hostId: string;
  /** Per-host fleet credential, shown once; the shared token cannot enroll this host again. */
  credential: string;
  heartbeatSeconds: number;
  pollWaitSeconds: number;
}

/** Fleet onboarding: how a fresh machine becomes a known, placeable host. */
@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);

  constructor(
    private readonly hostsService: HostsService,
    private readonly stats: StatsService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Enrollment for a fresh machine: its identity, its one-time credential and
   * cadence only. An already-enrolled hostId is refused with 409.
   *
   * Object-storage coordinates are deliberately absent: hosts move generations
   * through the fleet object routes, so the bucket and its credentials never
   * leave the control plane and cannot be exfiltrated from a host.
   */
  async enroll(input: { hostId?: string; runtime?: string }): Promise<EnrollResult> {
    this.checkedRuntime(input.runtime);
    const hostId = input.hostId?.trim() || `host-${randomUUID().slice(0, 8)}`;
    const credential = await this.hostsService.enrollHost(hostId, (input.runtime as Runtime | undefined) ?? 'microvm');
    return { hostId, credential, heartbeatSeconds: 30, pollWaitSeconds: this.pollWaitSeconds() };
  }

  /**
   * Registration is idempotent per hostId; the row is the placement truth.
   * `sharedToken` may only register a host that holds no credential yet (new,
   * or pre-credential) and gets one issued only if the docklet says it stores
   * it (`acceptsCredential`), so an older docklet stays credential-less under
   * the legacy flag. An enrolled host re-registers with its own credential.
   */
  async register(input: Omit<RegisterHostInput, 'address'> & { acceptsCredential?: boolean }, sharedToken: boolean): Promise<RegisterResult> {
    const { acceptsCredential, ...host } = input;
    // The host is the caller, so its row never carries an address to dial back.
    const row = { ...host, address: 'outbound' };
    let credential: string | undefined;
    if (sharedToken) credential = await this.hostsService.registerUnenrolled(row, acceptsCredential === true);
    else await this.hostsService.register(row);
    return { hostId: input.hostId, heartbeatSeconds: 30, pollWaitSeconds: this.pollWaitSeconds(), ...(credential ? { credential } : {}) };
  }

  async heartbeat(input: {
    hostId: string;
    runtime?: Runtime;
    usedDocks?: number;
    running?: HostWorkload[];
    samples?: HostSampleDto[];
    baseFingerprints?: string[];
  }): Promise<{ hostId: string }> {
    await this.hostsService.heartbeat(input.hostId, { runtime: input.runtime, usedDocks: input.usedDocks, running: input.running, baseFingerprints: input.baseFingerprints });
    await this.recordSamples(input.hostId, input.samples);
    return { hostId: input.hostId };
  }

  /**
   * Persists the host-truth counters riding this heartbeat so stats never
   * need a second round trip. Best effort: one bad sample (an unknown or
   * already-deleted dock) must not fail the heartbeat the host's liveness
   * depends on. Samples for docks not placed on the caller are dropped, so a
   * host cannot write another tenant's stats.
   */
  private async recordSamples(hostId: string, samples: HostSampleDto[] | undefined): Promise<void> {
    if (!samples?.length) return;
    const own = await this.hostsService.dockIdsOnHost(hostId, samples.map((sample) => sample.dockId));
    await Promise.all(
      samples.filter((sample) => own.has(sample.dockId)).map((sample) =>
        this.stats
          .record(sample.dockId, {
            cpuPercent: sample.cpuPercent,
            memBytes: sample.memBytes,
            memLimit: sample.memLimit,
            diskBytes: sample.diskBytes,
            rxBytes: sample.rxBytes,
            txBytes: sample.txBytes,
            containers: sample.containers ?? null,
            source: sample.source ?? 'host',
            at: sample.at ? new Date(sample.at) : undefined,
          })
          // Disk alerts need occupancy; the I/O counter would fire on busy, empty disks.
          .then(() => (typeof sample.diskUsedBytes === 'number' ? this.notifications.evaluateDisk(sample.dockId, sample.diskUsedBytes) : undefined))
          .catch((err) => this.logger.warn(`Dropped heartbeat sample for dock ${sample.dockId}: ${(err as Error).message}`)),
      ),
    );
  }

  private pollWaitSeconds(): number {
    const raw = Number(this.config.get<string>('FLEET_POLL_WAIT_SECONDS') ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : 25;
  }

  private checkedRuntime(runtime: unknown): void {
    if (runtime === undefined) return;
    if (typeof runtime === 'string' && (RUNTIMES as readonly string[]).includes(runtime)) return;
    throw new BadRequestException({ code: 'validation_error', message: 'runtime must be microvm or gvisor' });
  }
}
