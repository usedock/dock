import { diskGibMonths, SECONDS_PER_MONTH, windowUsage } from './usage';

const openedAt = new Date('2026-01-01T00:00:00Z');
const closedAt = new Date('2026-01-01T00:01:00Z');
const size = { cpus: 4, memoryMiB: 8192, diskGiB: 40, openedAt, closedAt };

describe('windowUsage', () => {
  it('records vcpu-seconds, memory GiB-seconds and disk for a running dock', () => {
    expect(windowUsage({ ...size, unit: 'compute' })).toEqual({ vcpuSeconds: 240, memoryGibSeconds: 480, diskGibSeconds: 2400 });
  });

  it('records disk only for a stopped dock', () => {
    expect(windowUsage({ ...size, unit: 'storage' })).toEqual({ vcpuSeconds: 0, memoryGibSeconds: 0, diskGibSeconds: 2400 });
  });

  it('accrues an open window up to now', () => {
    const now = new Date('2026-01-01T00:00:30Z');
    expect(windowUsage({ ...size, unit: 'compute', closedAt: null }, now).vcpuSeconds).toBe(120);
  });

  it('applies no multiplier across sizes', () => {
    const small = windowUsage({ ...size, unit: 'compute', cpus: 1, memoryMiB: 1024, diskGiB: 1 });
    expect(small).toEqual({ vcpuSeconds: 60, memoryGibSeconds: 60, diskGibSeconds: 60 });
  });

  it('converts disk GiB-seconds to GiB-months over 30 days', () => {
    expect(diskGibMonths(40 * SECONDS_PER_MONTH)).toBe(40);
  });
});
