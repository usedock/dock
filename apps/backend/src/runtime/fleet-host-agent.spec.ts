import { describe, expect, it, vi } from 'vitest';
import { FleetHostAgent } from './fleet-host-agent';
import type { HostCommandQueue } from '../fleet/host-command-queue';

describe('FleetHostAgent body tokens', () => {
  it('sends the same idempotency token in the body and the queue key for pause, load and destroy', async () => {
    const execute = vi.fn().mockResolvedValue({});
    const agent = new FleetHostAgent({ execute } as unknown as HostCommandQueue, 'h1');
    await agent.pause('d1');
    await agent.snapshotLoad('d1', { cpus: 2, memoryMiB: 4096, diskGiB: 20 }, 's1');
    await agent.destroy('d1');
    expect(execute).toHaveBeenCalledTimes(3);
    for (const [, , payload, token] of execute.mock.calls) {
      expect(token).toEqual(expect.any(String));
      expect(payload.idempotencyToken).toBe(token);
    }
  });
});
