import { buildDockletFactory } from './docklets.factory';
import { DockletClient } from '../runtime/docklet.client';
import { FleetHostAgent } from '../runtime/fleet-host-agent';
import { vi } from 'vitest';

describe('buildDockletFactory', () => {
  const hostRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'h1',
    address: 'outbound',
    cpuFamily: 'x86_64-v4',
    ...overrides,
  });

  const setup = (driver = 'restate') => {
    const hosts = { getById: vi.fn() };
    const config = { get: vi.fn((key: string) => ({ RUNTIME_DRIVER: driver })[key]) };
    const fallback = { baseUrl: 'fallback' } as unknown as DockletClient;
    const queue = {} as never;
    return {
      hosts,
      fallback,
      factory: buildDockletFactory(hosts as never, config as never, fallback, queue),
    };
  };

  it('addresses a registered host through the outbound command channel', async () => {
    const { hosts, factory, fallback } = setup();
    hosts.getById.mockResolvedValueOnce(hostRow());
    const client = await factory('h1');
    expect(client).toBeInstanceOf(FleetHostAgent);
    expect(client).not.toBe(fallback);
    expect(hosts.getById).toHaveBeenCalledWith('h1');
  });

  it('reuses one agent per host', async () => {
    const { hosts, factory } = setup();
    hosts.getById.mockResolvedValue(hostRow());
    const first = await factory('h1');
    const second = await factory('h1');
    expect(second).toBe(first);
  });

  it('refuses a host operation with no host id instead of using a local default', async () => {
    const { factory } = setup();
    await expect(factory(null)).rejects.toThrow(/hostId/);
  });

  it('refuses an unregistered host so work is never queued for nobody to collect', async () => {
    const { hosts, factory } = setup();
    hosts.getById.mockResolvedValueOnce(null);
    await expect(factory('ghost')).rejects.toThrow(/unknown host/);
  });

  it('keeps the direct client outside fleet mode for single-host development', async () => {
    const { hosts, factory, fallback } = setup('fake');
    await expect(factory(null)).resolves.toBe(fallback);
    hosts.getById.mockResolvedValueOnce(hostRow());
    await expect(factory('h1')).resolves.toBe(fallback);
  });
});
