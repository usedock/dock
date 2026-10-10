import { AgentCredentialsController } from './agent-credentials.controller';
import { vi, type Mock } from 'vitest';

describe('AgentCredentialsController', () => {
  const user = { id: 'u1' } as never;
  let creds: {
    list: Mock;
    set: Mock;
    reveal: Mock;
    remove: Mock;
  };
  let controller: AgentCredentialsController;

  beforeEach(() => {
    creds = { list: vi.fn(), set: vi.fn(), reveal: vi.fn(), remove: vi.fn() };
    controller = new AgentCredentialsController(creds as never);
  });

  it('lists scoped to the organization', async () => {
    creds.list.mockResolvedValue([{ provider: 'openai', configured: true }]);
    await expect(controller.list(user, { organizationId: 'org1' })).resolves.toEqual([
      { provider: 'openai', configured: true },
    ]);
    expect(creds.list).toHaveBeenCalledWith('u1', 'org1');
  });

  it('sets with body fields in order', async () => {
    creds.set.mockResolvedValue({ provider: 'openai', configured: true });
    await expect(
      controller.set(user, { organizationId: 'org1', provider: 'openai', key: 'sk' }),
    ).resolves.toEqual({ provider: 'openai', configured: true });
    expect(creds.set).toHaveBeenCalledWith('u1', 'org1', 'openai', 'sk');
  });

  it('reveals and removes by provider with query org', async () => {
    creds.reveal.mockResolvedValue({ provider: 'openai', key: 'sk' });
    await expect(controller.reveal(user, 'openai', { organizationId: 'org1' })).resolves.toEqual({
      provider: 'openai',
      key: 'sk',
    });
    expect(creds.reveal).toHaveBeenCalledWith('u1', 'org1', 'openai');
    creds.remove.mockResolvedValue({ provider: 'openai', configured: false });
    await expect(controller.remove(user, 'openai', { organizationId: 'org1' })).resolves.toEqual({
      provider: 'openai',
      configured: false,
    });
    expect(creds.remove).toHaveBeenCalledWith('u1', 'org1', 'openai');
  });

  it('lets service 400/403/404 errors propagate to the envelope filter', async () => {
    for (const method of ['list', 'set', 'reveal', 'remove'] as const) {
      for (const status of [400, 403, 404]) {
        const err = Object.assign(new Error(`${method} ${status}`), { status });
        creds[method].mockRejectedValueOnce(err);
        const args =
          method === 'list'
            ? [user, { organizationId: 'org1' }]
            : method === 'set'
              ? [user, { organizationId: 'org1', provider: 'openai', key: 'sk' }]
              : [user, 'openai', { organizationId: 'org1' }];
        await expect((controller[method] as (...a: never[]) => unknown)(...(args as never[]))).rejects.toMatchObject({
          status,
        });
      }
    }
  });
});
