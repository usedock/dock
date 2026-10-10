import { RetentionController } from './retention.controller';
import { vi, type Mock } from 'vitest';

describe('RetentionController', () => {
  let retention: { getPolicy: Mock; updatePolicy: Mock };
  let ops: { get: Mock };
  let controller: RetentionController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };
  const orgId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    retention = { getPolicy: vi.fn(), updatePolicy: vi.fn() };
    ops = { get: vi.fn() };
    controller = new RetentionController(retention as never, ops as never);
  });

  it('reads the switch scoped to the query org', async () => {
    retention.getPolicy.mockResolvedValue({ enabled: false });
    await expect(controller.getPolicy(user, { organizationId: orgId })).resolves.toEqual({ enabled: false });
    expect(retention.getPolicy).toHaveBeenCalledWith('u1', orgId);
  });

  it('writes with the exact phrase and org', async () => {
    retention.updatePolicy.mockResolvedValue({ enabled: true });
    await expect(
      controller.updatePolicy(user, { organizationId: orgId }, { enabled: true, confirmation: 'delete archived dock data' }),
    ).resolves.toEqual({ enabled: true });
    expect(retention.updatePolicy).toHaveBeenCalledWith(user, orgId, true, 'delete archived dock data');
  });

  it('rejects writes without an org', () => {
    let thrown: unknown;
    try {
      controller.updatePolicy(user, {} as never, { enabled: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ response: { code: 'validation_error' } });
    expect(retention.updatePolicy).not.toHaveBeenCalled();
  });

  it('polls operations by display id scoped to the caller', async () => {
    ops.get.mockResolvedValue({ id: 'op_1', status: 'completed' });
    await expect(controller.getOperation(user, 'op_1')).resolves.toMatchObject({ status: 'completed' });
    expect(ops.get).toHaveBeenCalledWith('u1', 'op_1');
  });
});
