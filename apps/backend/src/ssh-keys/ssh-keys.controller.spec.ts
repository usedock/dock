import { vi, type Mock } from 'vitest';
import { SshKeysController } from './ssh-keys.controller';

describe('SshKeysController', () => {
  let keys: { create: Mock; list: Mock; remove: Mock };
  let controller: SshKeysController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true };

  beforeEach(() => {
    keys = { create: vi.fn().mockResolvedValue({ id: 'k1' }), list: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue({ deleted: true }) };
    controller = new SshKeysController(keys as never);
  });

  it('scopes every call to the current user', async () => {
    await controller.create(user, { name: 'laptop', publicKey: 'ssh-ed25519 AAAA' });
    expect(keys.create).toHaveBeenCalledWith('u1', 'laptop', 'ssh-ed25519 AAAA');
    await controller.list(user);
    expect(keys.list).toHaveBeenCalledWith('u1');
    await controller.remove(user, 'k1');
    expect(keys.remove).toHaveBeenCalledWith('u1', 'k1');
  });
});
