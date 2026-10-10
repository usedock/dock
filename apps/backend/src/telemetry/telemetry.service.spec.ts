import { vi, type Mock } from 'vitest';
import { TelemetryService } from './telemetry.service';

const KEYS = ['arch', 'docks', 'hosts', 'os', 'runningDocks', 'version'];
const DAY_MS = 24 * 60 * 60 * 1000;

function makeDb(counts: number[]) {
  let i = 0;
  return {
    select: () => ({
      from: () => {
        const n = counts[i++];
        return Object.assign(Promise.resolve([{ n }]), { where: () => Promise.resolve([{ n }]) });
      },
    }),
  };
}

function makeService(env: Record<string, string>) {
  const config = { get: (k: string) => env[k] };
  return new TelemetryService(makeDb([2, 5, 3]) as never, config as never);
}

describe('TelemetryService', () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('makes no request with the default config', async () => {
    const service = makeService({ DOCK_TELEMETRY: 'off', DOCK_TELEMETRY_URL: 'https://t.example/v1' });
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    service.onModuleDestroy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no request when DOCK_TELEMETRY is unset', async () => {
    const service = makeService({});
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    service.onModuleDestroy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports after boot with exactly the documented keys and stops on destroy', async () => {
    const service = makeService({ DOCK_TELEMETRY: 'on', DOCK_TELEMETRY_URL: 'https://t.example/v1' });
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://t.example/v1');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body).toMatchObject({ hosts: 2, docks: 5, runningDocks: 3 });
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the endpoint fails', async () => {
    const service = makeService({ DOCK_TELEMETRY: 'on', DOCK_TELEMETRY_URL: 'https://t.example/v1' });
    fetchSpy.mockRejectedValue(new Error('offline'));
    await expect(service.report()).resolves.toBeUndefined();
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    await expect(service.report()).resolves.toBeUndefined();
  });
});
