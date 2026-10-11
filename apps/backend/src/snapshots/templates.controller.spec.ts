import { TemplatesController } from './templates.controller';
import { vi, type Mock } from 'vitest';

const templateRow = {
  id: 't1', organizationId: 'o1', name: 'web-stack', sourceDockId: 'd1', status: 'saving', sizeBytes: 1,
  createdAt: new Date(), updatedAt: new Date(), snapshotRef: 'ref', storeSnapshotId: 'gen', cpuFamily: null,
  runtime: null, baseFingerprint: null, savingSince: new Date(),
};

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

  it('returns the view for save, list and get, including the state of unfinished templates', async () => {
    const keys = ['id', 'organizationId', 'name', 'sourceDockId', 'status', 'sizeBytes', 'createdAt', 'updatedAt'].sort();
    templates.save.mockResolvedValue(templateRow);
    templates.list.mockResolvedValue([templateRow, { ...templateRow, status: 'failed' }]);
    templates.get.mockResolvedValue(templateRow);
    const listed = await controller.list(user);
    expect(listed.map((t) => t.status)).toEqual(['saving', 'failed']);
    for (const t of [await controller.save(user, { dockId: 'd1', name: 'web-stack' }), listed[0], await controller.get(user, 'web-stack', { organizationId: 'o1' })]) {
      expect(Object.keys(t).sort()).toEqual(keys);
    }
  });

  it('removes by name without a confirm header', async () => {
    templates.remove.mockResolvedValue({ operation: { id: 'op_2' } });
    await expect(controller.remove(user, 'web-stack', { organizationId: 'o1' })).resolves.toEqual({ operation: { id: 'op_2' } });
    expect(templates.remove).toHaveBeenCalledWith('u1', 'o1', 'web-stack');
  });
});
