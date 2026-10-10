import { TemplatesController } from './templates.controller';
import { vi, type Mock } from 'vitest';

describe('TemplatesController', () => {
  let templates: { save: Mock; list: Mock; get: Mock; remove: Mock };
  let controller: TemplatesController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };

  beforeEach(() => {
    templates = { save: vi.fn(), list: vi.fn(), get: vi.fn(), remove: vi.fn() };
    controller = new TemplatesController(templates as never);
  });

  it('saves scoped to the user with dock and name', async () => {
    templates.save.mockResolvedValue({ name: 'web-stack', status: 'saving' });
    await expect(controller.save(user, { dockId: 'd1', name: 'web-stack' })).resolves.toMatchObject({
      name: 'web-stack',
    });
    expect(templates.save).toHaveBeenCalledWith('u1', 'd1', 'web-stack');
  });

  it('lists and gets within the caller scope', async () => {
    templates.list.mockResolvedValue([]);
    templates.get.mockResolvedValue({ name: 'web-stack' });
    await expect(controller.list(user)).resolves.toEqual([]);
    await expect(controller.get(user, 'web-stack', { organizationId: 'o1' })).resolves.toMatchObject({ name: 'web-stack' });
    expect(templates.list).toHaveBeenCalledWith('u1');
    expect(templates.get).toHaveBeenCalledWith('u1', 'o1', 'web-stack');
  });

  it('removes by name without a confirm header', async () => {
    templates.remove.mockResolvedValue({ operation: { id: 'op_2' } });
    await expect(controller.remove(user, 'web-stack', { organizationId: 'o1' })).resolves.toEqual({ operation: { id: 'op_2' } });
    expect(templates.remove).toHaveBeenCalledWith('u1', 'o1', 'web-stack');
  });
});
