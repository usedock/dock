import { ApiKeysController } from './api-keys.controller';
import { vi, type Mock } from 'vitest';

describe('ApiKeysController', () => {
  let keys: {
    create: Mock;
    list: Mock;
    revoke: Mock;
  };
  let controller: ApiKeysController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true };

  beforeEach(() => {
    keys = { create: vi.fn(), list: vi.fn(), revoke: vi.fn() };
    controller = new ApiKeysController(keys as never);
  });

  it('creates scoped to the current user and parses expiresAt', async () => {
    keys.create.mockResolvedValue({ id: 'k1', apiKey: 'dock_secret' });
    await expect(
      controller.create(user, { name: 'ci', expiresAt: '2027-01-01T00:00:00.000Z' }),
    ).resolves.toEqual({ id: 'k1', apiKey: 'dock_secret' });
    expect(keys.create).toHaveBeenCalledWith('u1', 'ci', new Date('2027-01-01T00:00:00.000Z'));
  });

  it('creates without expiry when omitted', async () => {
    keys.create.mockResolvedValue({ id: 'k1' });
    await controller.create(user, { name: 'ci' });
    expect(keys.create).toHaveBeenCalledWith('u1', 'ci', undefined);
  });

  it('lists scoped to the current user', async () => {
    keys.list.mockResolvedValue([]);
    await expect(controller.list(user)).resolves.toEqual([]);
    expect(keys.list).toHaveBeenCalledWith('u1');
  });

  it('revokes scoped to the current user', async () => {
    keys.revoke.mockResolvedValue({ revoked: true });
    await expect(controller.revoke(user, 'k1')).resolves.toEqual({ revoked: true });
    expect(keys.revoke).toHaveBeenCalledWith('u1', 'k1');
  });
});
