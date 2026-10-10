import { vi } from 'vitest';
import { ChatgptController } from './chatgpt.controller';

describe('ChatgptController', () => {
  it('scopes every call to the current user', async () => {
    const chatgpt = { get: vi.fn(), start: vi.fn(), poll: vi.fn(), remove: vi.fn() };
    const controller = new ChatgptController(chatgpt as never);
    const user = { id: 'u1', email: 'a@b.co', emailVerified: true };
    await controller.get(user);
    await controller.start(user);
    await controller.poll(user);
    await controller.remove(user);
    for (const fn of Object.values(chatgpt)) expect(fn).toHaveBeenCalledWith('u1');
  });
});
