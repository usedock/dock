import { vi } from 'vitest';
import { ConnectorsController } from './connectors.controller';

describe('ConnectorsController', () => {
  it('passes the caller, workspace and kind to the service', async () => {
    const svc = { list: vi.fn().mockResolvedValue([]), connect: vi.fn().mockResolvedValue({}), disconnect: vi.fn().mockResolvedValue({}) };
    const ctrl = new ConnectorsController(svc as never);
    const user = { id: 'u1' } as never;
    await ctrl.list(user, 'w1');
    await ctrl.connect(user, 'w1', 'linear', { token: 'lin_api_x' });
    await ctrl.disconnect(user, 'w1', 'linear');
    expect(svc.list).toHaveBeenCalledWith('u1', 'w1');
    expect(svc.connect).toHaveBeenCalledWith('u1', 'w1', 'linear', 'lin_api_x');
    expect(svc.disconnect).toHaveBeenCalledWith('u1', 'w1', 'linear');
  });
});
