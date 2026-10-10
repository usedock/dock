import { EnvironmentsController } from './environments.controller';
import { vi, type Mock } from 'vitest';

describe('EnvironmentsController', () => {
  let envs: {
    listByOrg: Mock;
    create: Mock;
    getByRef: Mock;
    update: Mock;
    remove: Mock;
    listVersions: Mock;
    listRepos: Mock;
    addRepo: Mock;
    removeRepo: Mock;
    replaceSecrets: Mock;
    setVar: Mock;
    removeVar: Mock;
    setFile: Mock;
    removeFile: Mock;
    revealSecrets: Mock;
  };
  let applier: { upgrade: Mock };
  let controller: EnvironmentsController;
  const user = { id: 'u1', email: 'a@b.co', emailVerified: true, isInteractive: true };

  beforeEach(() => {
    envs = {
      listByOrg: vi.fn(),
      create: vi.fn(),
      getByRef: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      listVersions: vi.fn(),
      listRepos: vi.fn(),
      addRepo: vi.fn(),
      removeRepo: vi.fn(),
      replaceSecrets: vi.fn(),
      setVar: vi.fn(),
      removeVar: vi.fn(),
      setFile: vi.fn(),
      removeFile: vi.fn(),
      revealSecrets: vi.fn(),
    };
    applier = { upgrade: vi.fn() };
    controller = new EnvironmentsController(envs as never, applier as never);
  });

  it('scopes identity routes to the user with the org query', async () => {
    envs.listByOrg.mockResolvedValue([]);
    envs.getByRef.mockResolvedValue({ id: 'e1' });
    await expect(controller.list(user, { organizationId: 'org-1' })).resolves.toEqual([]);
    await expect(controller.getByRef(user, 'base', { organizationId: 'org-1' })).resolves.toEqual({ id: 'e1' });
    expect(envs.listByOrg).toHaveBeenCalledWith('u1', 'org-1');
    expect(envs.getByRef).toHaveBeenCalledWith('u1', 'base', 'org-1');
  });

  it('creates and upgrades with bodies', async () => {
    envs.create.mockResolvedValue({ id: 'e1' });
    applier.upgrade.mockResolvedValue({ operation: { id: 'op_1' } });
    await expect(controller.create(user, { organizationId: 'org-1', name: 'staging' })).resolves.toEqual({ id: 'e1' });
    await expect(controller.upgrade(user, 'staging', { organizationId: 'org-1' }, { dockIds: ['d1'] })).resolves.toEqual({
      operation: { id: 'op_1' },
    });
    expect(envs.create).toHaveBeenCalledWith('u1', 'org-1', 'staging', undefined);
    expect(applier.upgrade).toHaveBeenCalledWith('u1', 'staging', 'org-1', ['d1']);
  });

  it('delegates repos and secrets with ref and query', async () => {
    envs.addRepo.mockResolvedValue({ id: 'e1' });
    envs.setVar.mockResolvedValue({ id: 'e1' });
    envs.revealSecrets.mockResolvedValue({ envContents: '' });
    await controller.addRepo(user, 'base', {}, { provider: 'github', repositoryId: '1', fullName: 'o/r' });
    await controller.setVar(user, 'base', {}, { key: 'A', value: '1' });
    await controller.reveal(user, 'base', {});
    expect(envs.addRepo).toHaveBeenCalledWith('u1', 'base', undefined, {
      provider: 'github',
      repositoryId: '1',
      fullName: 'o/r',
    });
    expect(envs.setVar).toHaveBeenCalledWith('u1', 'base', undefined, 'A', '1');
    expect(envs.revealSecrets).toHaveBeenCalledWith('u1', 'base', undefined);
  });

  it('delegates update, remove, versions, and file removal', async () => {
    await controller.update(user, 'base', {}, { isDefault: true });
    await controller.remove(user, 'staging', {});
    await controller.listVersions(user, 'base', {});
    await controller.removeFile(user, 'base', 'backend/.env', {});
    expect(envs.update).toHaveBeenCalledWith('u1', 'base', undefined, { isDefault: true });
    expect(envs.remove).toHaveBeenCalledWith('u1', 'staging', undefined);
    expect(envs.listVersions).toHaveBeenCalledWith('u1', 'base', undefined);
    expect(envs.removeFile).toHaveBeenCalledWith('u1', 'base', undefined, 'backend/.env');
  });
});
