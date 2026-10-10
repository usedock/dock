import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { vi, type Mock } from 'vitest';
import { FleetController } from './fleet.controller';

const AS_A = 'Bearer hc_a';

describe('FleetController host scoping', () => {
  let fleet: { register: Mock; heartbeat: Mock; enroll: Mock };
  let queue: { assertToken: Mock; isEnrollToken: Mock; authenticateHost: Mock; poll: Mock; recordResult: Mock };
  let controller: FleetController;

  beforeEach(() => {
    fleet = { register: vi.fn(async () => ({})), heartbeat: vi.fn(async () => ({})), enroll: vi.fn(async () => ({})) };
    queue = {
      assertToken: vi.fn(),
      isEnrollToken: vi.fn((token?: string) => token === 'shared'),
      authenticateHost: vi.fn(async (token?: string) => {
        if (token === 'hc_a') return 'host-a';
        throw new UnauthorizedException({ code: 'host_credential_unknown', message: 'unknown' });
      }),
      poll: vi.fn(async () => null),
      recordResult: vi.fn(async () => ({ accepted: true })),
    };
    controller = new FleetController(fleet as never, queue as never, {} as never, {} as never);
  });

  const registerDto = { hostId: 'host-a', cpuFamily: 'x', kernel: 'k', vcpuTotal: 1, memTotalBytes: 1, diskTotalBytes: 1, maxDocks: 1 };

  it('issues a credential only for the enrollment token on register', async () => {
    await controller.register('Bearer shared', registerDto);
    expect(fleet.register).toHaveBeenLastCalledWith(registerDto, true);
    await controller.register(AS_A, registerDto);
    expect(fleet.register).toHaveBeenLastCalledWith(registerDto, false);
  });

  it('refuses a host re-registering as another host', async () => {
    await expect(controller.register(AS_A, { ...registerDto, hostId: 'host-b' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(fleet.register).not.toHaveBeenCalled();
  });

  it('polls only the authenticated host queue, never the one named in the query', async () => {
    await controller.commands(AS_A, undefined, '0');
    expect(queue.poll).toHaveBeenCalledWith('host-a', 0);
    await expect(controller.commands(AS_A, 'host-b', '0')).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.poll).toHaveBeenCalledTimes(1);
  });

  it('posts results as the authenticated host so another host command is refused downstream', async () => {
    await controller.result(AS_A, 'cmd-of-b', { ok: true });
    expect(queue.recordResult).toHaveBeenCalledWith('host-a', 'cmd-of-b', { ok: true });
    await expect(controller.result(AS_A, 'c1', { ok: true, hostId: 'host-b' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.recordResult).toHaveBeenCalledTimes(1);
  });

  it('heartbeats as the authenticated host and refuses a spoofed hostId', async () => {
    await controller.heartbeat(AS_A, { usedDocks: 1 });
    expect(fleet.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-a' }));
    await expect(controller.heartbeat(AS_A, { hostId: 'host-b' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(fleet.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('refuses the shared token and unknown credentials on every host call', async () => {
    const shared = 'Bearer shared';
    await expect(controller.heartbeat(shared, {})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.commands(shared, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.result(shared, 'c1', { ok: true })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.register('Bearer hc_unknown', registerDto)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(queue.poll).not.toHaveBeenCalled();
    expect(queue.recordResult).not.toHaveBeenCalled();
  });

  it('passes the client-claimed hostId only as a hint for the legacy transition', async () => {
    await controller.heartbeat(AS_A, { hostId: 'host-a' });
    expect(queue.authenticateHost).toHaveBeenLastCalledWith('hc_a', 'host-a');
    await controller.commands(AS_A, 'host-a', '0');
    expect(queue.authenticateHost).toHaveBeenLastCalledWith('hc_a', 'host-a');
    await controller.result(AS_A, 'c1', { ok: true, hostId: 'host-a' });
    expect(queue.authenticateHost).toHaveBeenLastCalledWith('hc_a', 'host-a');
  });
});
