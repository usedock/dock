import { vi } from 'vitest';
import { GithubAppSetupController } from './github-app-setup.controller';

describe('GithubAppSetupController', () => {
  it('delegates start and conversion with the caller', async () => {
    const setup = { start: vi.fn(), convert: vi.fn() };
    const controller = new GithubAppSetupController(setup as never);
    const user = { id: 'u1', email: 'a@x.co', emailVerified: true, isInteractive: true };
    await controller.start(user, { organization: 'acme' });
    expect(setup.start).toHaveBeenCalledWith(user, 'acme');
    await controller.convert(user, { code: 'c', state: 's' });
    expect(setup.convert).toHaveBeenCalledWith(user, 'c', 's');
  });
});
