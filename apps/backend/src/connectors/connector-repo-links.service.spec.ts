import { ForbiddenException } from '@nestjs/common';
import { vi, type Mock } from 'vitest';
import { ConnectorRepoLinksService } from './connector-repo-links.service';

const rows = (data: unknown[]) => {
  const p = Promise.resolve(data);
  return Object.assign(p, { limit: vi.fn().mockResolvedValue(data), orderBy: vi.fn().mockResolvedValue(data), returning: vi.fn().mockResolvedValue(data) });
};

describe('ConnectorRepoLinksService', () => {
  let selects: unknown[][];
  let db: { select: Mock; insert: Mock; delete: Mock; values: Mock; onConflict: Mock };
  let connectors: { requireAdmin: Mock; kindOf: Mock };
  let github: { configured: Mock; mint: Mock; revoke: Mock; api: { listInstallationRepositories: Mock } };
  let service: ConnectorRepoLinksService;
  const linkRow = { scope: 'T1', repo: 'acme/app', createdAt: new Date(0), installationId: 7 };

  beforeEach(() => {
    selects = [];
    const onConflict = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([linkRow]) });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflict });
    db = {
      select: vi.fn().mockImplementation(() => ({ from: () => ({ where: () => rows(selects.shift() ?? []) }) })),
      insert: vi.fn().mockReturnValue({ values }),
      delete: vi.fn().mockReturnValue({ where: () => rows([{ id: 'l1' }]) }),
      values,
      onConflict,
    };
    connectors = {
      requireAdmin: vi.fn().mockResolvedValue({ id: 'w1', organizationId: 'o1' }),
      kindOf: vi.fn().mockImplementation((k: string) => {
        if (!['linear', 'slack', 'sentry', 'figma'].includes(k)) throw new Error('bad kind');
        return k;
      }),
    };
    github = {
      configured: vi.fn().mockReturnValue(true),
      mint: vi.fn().mockImplementation(async (_i: number, repo?: string) => (repo ? 'ghs_write' : 'ghs_list')),
      revoke: vi.fn().mockResolvedValue(undefined),
      api: { listInstallationRepositories: vi.fn().mockResolvedValue(['acme/app', 'acme/other']) },
    };
    service = new ConnectorRepoLinksService(db as never, connectors as never, github as never);
  });

  it('is admin only: every route goes through requireAdmin and a refusal reaches the caller', async () => {
    connectors.requireAdmin.mockRejectedValue(new ForbiddenException());
    await expect(service.list('u1', 'w1', 'linear')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.put('u1', 'w1', 'linear', { scope: 'T1', repo: 'acme/app' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove('u1', 'w1', 'linear', 'T1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
    expect(github.mint).not.toHaveBeenCalled();
  });

  it('links a scope after the installation lists the repo and can mint publish permissions, revoking both probes', async () => {
    selects = [[{ id: 'c1' }], [{ installationId: 7 }]];
    expect(await service.put('u1', 'w1', 'linear', { scope: 'T1', repo: 'acme/app' })).toEqual({ scope: 'T1', repo: 'acme/app', createdAt: linkRow.createdAt });
    expect(github.mint).toHaveBeenNthCalledWith(1, 7, undefined, { contents: 'read' });
    expect(github.mint).toHaveBeenNthCalledWith(2, 7, 'app', { contents: 'write', pull_requests: 'write' });
    expect(github.revoke).toHaveBeenCalledWith('ghs_list');
    expect(github.revoke).toHaveBeenCalledWith('ghs_write');
    expect(db.values).toHaveBeenCalledWith({ workspaceId: 'w1', kind: 'linear', scope: 'T1', repo: 'acme/app', installationId: 7, createdBy: 'u1' });
  });

  it('refuses a repository no installation of the workspace can reach', async () => {
    selects = [[{ id: 'c1' }], [{ installationId: 7 }]];
    await expect(service.put('u1', 'w1', 'slack', { scope: '*', repo: 'evil/secret' })).rejects.toMatchObject({ response: { code: 'github_repo_not_accessible' } });
    expect(db.insert).not.toHaveBeenCalled();
    expect(github.revoke).toHaveBeenCalledWith('ghs_list');
  });

  it('refuses when the App lacks write access on the repo', async () => {
    selects = [[{ id: 'c1' }], [{ installationId: 7 }]];
    github.mint.mockImplementation(async (_i: number, repo?: string) => {
      if (repo) throw new Error('token mint failed with status 422');
      return 'ghs_list';
    });
    await expect(service.put('u1', 'w1', 'slack', { scope: '*', repo: 'acme/app' })).rejects.toMatchObject({ response: { code: 'github_permissions_missing' } });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses without an installation, without the App configured, and for a tool that is not connected', async () => {
    selects = [[{ id: 'c1' }], []];
    await expect(service.put('u1', 'w1', 'slack', { scope: '*', repo: 'acme/app' })).rejects.toMatchObject({ response: { code: 'github_installation_missing' } });
    selects = [[{ id: 'c1' }]];
    github.configured.mockReturnValue(false);
    await expect(service.put('u1', 'w1', 'slack', { scope: '*', repo: 'acme/app' })).rejects.toMatchObject({ response: { code: 'github_app_not_configured' } });
    selects = [[]];
    await expect(service.put('u1', 'w1', 'slack', { scope: '*', repo: 'acme/app' })).rejects.toMatchObject({ response: { code: 'connector_not_found' } });
  });

  it('validates scope and repo shape before touching GitHub', async () => {
    for (const repo of ['acme', 'acme/app/x', '../x', 'acme/..', 'a b/c']) {
      await expect(service.put('u1', 'w1', 'slack', { scope: '*', repo })).rejects.toMatchObject({ response: { code: 'validation_error' } });
    }
    await expect(service.put('u1', 'w1', 'slack', { scope: 'has space', repo: 'acme/app' })).rejects.toMatchObject({ response: { code: 'validation_error' } });
    expect(github.mint).not.toHaveBeenCalled();
  });

  it('lists links and deletes one, 404ing an unknown scope', async () => {
    selects = [[linkRow]];
    expect(await service.list('u1', 'w1', 'linear')).toEqual({ links: [{ scope: 'T1', repo: 'acme/app', createdAt: linkRow.createdAt }] });
    expect(await service.remove('u1', 'w1', 'linear', 'T1')).toEqual({ removed: true });
    db.delete.mockReturnValue({ where: () => rows([]) });
    await expect(service.remove('u1', 'w1', 'linear', 'nope')).rejects.toMatchObject({ response: { code: 'repo_link_not_found' } });
    await expect(service.list('u1', 'w1', 'bogus')).rejects.toThrow('bad kind');
  });

  it('resolves the exact scope first, then the wildcard, then nothing', async () => {
    const any = { scope: '*', repo: 'acme/any' };
    const exact = { scope: 'T1', repo: 'acme/team' };
    selects = [[any, exact]];
    expect(await service.resolve('w1', 'linear', 'T1')).toBe(exact);
    selects = [[any, exact]];
    expect(await service.resolve('w1', 'linear', 'T2')).toBe(any);
    selects = [[exact]];
    expect(await service.resolve('w1', 'linear', undefined)).toBeNull();
  });
});
