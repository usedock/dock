import type { MeteringWindow } from '../database/schema';

/** Disk accrues in GiB-seconds; one GiB-month is 30 days. */
export const SECONDS_PER_MONTH = 30 * 24 * 3600;

export interface WindowUsage {
  vcpuSeconds: number;
  memoryGibSeconds: number;
  diskGibSeconds: number;
}

type SizedWindow = Pick<MeteringWindow, 'unit' | 'cpus' | 'memoryMiB' | 'diskGiB' | 'openedAt' | 'closedAt'>;

/** Compute windows (running docks) accrue all three; storage windows (stopped docks) accrue disk only. No multipliers. */
export function windowUsage(window: SizedWindow, now: Date = new Date()): WindowUsage {
  const end = window.closedAt ?? now;
  const seconds = Math.max(0, (end.getTime() - window.openedAt.getTime()) / 1000);
  const running = window.unit === 'compute';
  return {
    vcpuSeconds: running ? window.cpus * seconds : 0,
    memoryGibSeconds: running ? (window.memoryMiB / 1024) * seconds : 0,
    diskGibSeconds: window.diskGiB * seconds,
  };
}

export function diskGibMonths(diskGibSeconds: number): number {
  return diskGibSeconds / SECONDS_PER_MONTH;
}
