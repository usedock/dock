import { AccountClosureController } from './account-closure.controller';
import { vi, type Mock } from 'vitest';

describe('AccountClosureController', () => {
  let closure: { close: Mock; reopen: Mock; erase: Mock };
  let controller: AccountClosureController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };

  beforeEach(() => {
    closure = { close: vi.fn(), reopen: vi.fn(), erase: vi.fn() };
    controller = new AccountClosureController(closure as never);
  });

  it('closes with the full session user', async () => {
    closure.close.mockResolvedValue({ closed: true, purgeAt: new Date() });
    await controller.close(user);
    expect(closure.close).toHaveBeenCalledWith(user);
  });

  it('reopens by user id', async () => {
    closure.reopen.mockResolvedValue({ reopened: true });
    await expect(controller.reopen(user)).resolves.toEqual({ reopened: true });
    expect(closure.reopen).toHaveBeenCalledWith('u1');
  });

  it('erases with the confirmation phrase', async () => {
    closure.erase.mockResolvedValue({ erased: true });
    await expect(controller.erase(user, { confirmation: 'erase my account data' })).resolves.toEqual({
      erased: true,
    });
    expect(closure.erase).toHaveBeenCalledWith(user, 'erase my account data');
  });
});
