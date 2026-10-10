import { ForbiddenException } from '@nestjs/common';
import { vi } from 'vitest';
import { HostsController } from './hosts.controller';

describe('HostsController reset-credential', () => {
  const hosts = { resetCredential: vi.fn(async () => ({ hostId: 'h1', credential: 'hc_new' })) };
  const controller = new HostsController(hosts as never);
  const user = (isInteractive?: boolean) => ({ id: 'u1', email: 'ops@example.com', emailVerified: true, isInteractive });

  beforeEach(() => hosts.resetCredential.mockClear());

  it('requires an interactive session, not an API key', () => {
    expect(() => controller.resetCredential(user(false), 'h1')).toThrow(ForbiddenException);
    expect(() => controller.resetCredential(user(undefined), 'h1')).toThrow(ForbiddenException);
    expect(hosts.resetCredential).not.toHaveBeenCalled();
  });

  it('delegates an interactive admin session to the service', async () => {
    await expect(controller.resetCredential(user(true), 'h1')).resolves.toEqual({ hostId: 'h1', credential: 'hc_new' });
    expect(hosts.resetCredential).toHaveBeenCalledWith(expect.objectContaining({ email: 'ops@example.com', emailVerified: true }), 'h1');
  });
});
