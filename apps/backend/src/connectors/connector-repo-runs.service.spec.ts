import { vi, type Mock } from 'vitest';
import { ConnectorGithub } from './connector-github';
import { ConnectorRepoRunsService, RepoPublishError } from './connector-repo-runs.service';
import { redactSecrets } from './connector-redact';

const RUN = { id: '11111111-1111-4111-8111-111111111111', workspaceId: 'w1', kind: 'linear', reply: { issueId: 'i1' } } as never;
const link = { repo: 'acme/app', installationId: 7 } as never;
const BASE = 'a'.repeat(40);
const repoRow = { runId: (RUN as { id: string }).id, repo: 'acme/app', installationId: 7, baseBranch: 'main', baseSha: BASE, branch: 'dock/linear-11111111', title: 'DOC-1 Fix login', subjectUrl: 'https://linear.app/acme/issue/DOC-1' };
const changes = [{ path: 'src/a.ts', mode: '100644' as const, content: 'eA==' }, { path: 'old.txt', deleted: true }];

describe('ConnectorRepoRunsService', () => {
  let github: { mint: Mock; revoke: Mock; api: Record<string, Mock> };
  let db: { insert: Mock; update: Mock; select: Mock; inserted: Mock; updateSet: Mock };
  let service: ConnectorRepoRunsService;

  beforeEach(() => {
    github = {
      mint: vi.fn().mockResolvedValue('ghs_' + 'a1'.repeat(18)),
      revoke: vi.fn().mockResolvedValue(undefined),
      api: {
        getDefaultBranch: vi.fn().mockResolvedValue('main'),
        getBranchHead: vi.fn().mockResolvedValue({ sha: BASE }),
        getCommitTree: vi.fn().mockResolvedValue({ treeSha: 't0' }),
        createBlob: vi.fn().mockResolvedValue({ sha: 'b1' }),
        createTree: vi.fn().mockResolvedValue({ sha: 't1' }),
        createCommit: vi.fn().mockResolvedValue({ sha: 'c1' }),
        setBranch: vi.fn().mockResolvedValue(undefined),
        createPullRequest: vi.fn().mockResolvedValue({ number: 9, url: 'https://github.com/acme/app/pull/9' }),
      },
    };
    const inserted = vi.fn().mockReturnValue({ returning: vi.fn().mockImplementation(async () => [repoRow]) });
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    db = {
      inserted,
      updateSet,
      insert: vi.fn().mockReturnValue({ values: inserted }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
      select: vi.fn().mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [repoRow] }) }) }),
    };
    service = new ConnectorRepoRunsService(db as never, github as never);
  });

  describe('prepare', () => {
    it('mints a read-only token for the single repository, pins the base and records the run branch', async () => {
      const out = await service.prepare(RUN, link, { kind: 'linear', key: 'issue:i1', title: 'DOC-1\nFix login', body: '', url: 'https://linear.app/acme/issue/DOC-1', reply: {} });
      expect(github.mint).toHaveBeenCalledWith(7, 'app', { contents: 'read' });
      expect(github.api.getDefaultBranch).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', repo: 'app' }));
      expect(db.inserted).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'main', baseSha: BASE, branch: 'dock/linear-11111111', title: 'DOC-1 Fix login', subjectUrl: 'https://linear.app/acme/issue/DOC-1' }));
      expect(out.readToken).toMatch(/^ghs_/);
      expect(github.revoke).not.toHaveBeenCalled();
    });

    it('drops a non-https subject link and revokes the token when pinning the base fails', async () => {
      await service.prepare(RUN, link, { kind: 'linear', key: 'k', title: 't', body: '', url: 'javascript:alert(1)', reply: {} });
      expect(db.inserted).toHaveBeenCalledWith(expect.objectContaining({ subjectUrl: null }));
      github.api.getBranchHead.mockRejectedValue(new Error('404'));
      await expect(service.prepare(RUN, link, { kind: 'linear', key: 'k', title: 't', body: '', url: null, reply: {} })).rejects.toThrow('404');
      expect(github.revoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('publish', () => {
    it('mints a single-repo write token, commits on the run branch from the pinned base, opens a draft PR linking back, and revokes', async () => {
      const url = await service.publish(RUN, repoRow as never, { parentSha: BASE, changes, summary: 'Fixed it. ping @octocat' });
      expect(url).toBe('https://github.com/acme/app/pull/9');
      expect(github.mint).toHaveBeenCalledWith(7, 'app', { contents: 'write', pull_requests: 'write' });
      expect(github.api.getCommitTree).toHaveBeenCalledWith(expect.objectContaining({ sha: BASE }));
      expect(github.api.createTree).toHaveBeenCalledWith(expect.objectContaining({ entries: [{ path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'b1' }, { path: 'old.txt', mode: '100644', type: 'blob', sha: null }] }));
      expect(github.api.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [BASE] }));
      expect(github.api.setBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'dock/linear-11111111', create: true }));
      const pr = github.api.createPullRequest.mock.calls[0][0];
      expect(pr).toMatchObject({ head: 'dock/linear-11111111', base: 'main', title: '[dock] DOC-1 Fix login', draft: true });
      expect(pr.body).toContain('Linear issue: https://linear.app/acme/issue/DOC-1');
      expect(pr.body).toContain('Fixed it.');
      expect(pr.body).not.toContain('@octocat');
      expect(db.updateSet).toHaveBeenCalledWith({ prUrl: 'https://github.com/acme/app/pull/9' });
      expect(github.revoke).toHaveBeenCalledTimes(1);
    });

    it('scrubs GitHub tokens from the PR body', async () => {
      await service.publish(RUN, repoRow as never, { parentSha: BASE, changes, summary: `token ghs_${'Ab1'.repeat(12)} leaked` });
      expect(github.api.createPullRequest.mock.calls[0][0].body).not.toContain('ghs_');
    });

    it('refuses a start commit other than the pinned base, unsafe paths, and an empty change set, without minting a token', async () => {
      await expect(service.publish(RUN, repoRow as never, { parentSha: 'b'.repeat(40), changes, summary: '' })).rejects.toMatchObject({ code: 'push_failed' });
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes: [{ path: '../x', content: '' }], summary: '' })).rejects.toMatchObject({ code: 'unsupported_change' });
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes: [{ path: '.git/config', content: '' }], summary: '' })).rejects.toMatchObject({ code: 'unsupported_change' });
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes: [], summary: '' })).rejects.toMatchObject({ code: 'empty_fix' });
      expect(github.mint).not.toHaveBeenCalled();
    });

    it('refuses workflow files and an installation the workspace no longer owns, without minting a token', async () => {
      for (const path of ['.github/workflows/ci.yml', '.GitHub/Workflows/x.yaml']) {
        await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes: [{ path, content: 'eA==' }], summary: '' })).rejects.toMatchObject({ code: 'workflow_change_refused' });
      }
      db.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes, summary: '' })).rejects.toMatchObject({ code: 'repo_unavailable' });
      expect(github.mint).not.toHaveBeenCalled();
    });

    it('reports the failing step and still revokes the token', async () => {
      github.api.setBranch.mockRejectedValue(new Error('422'));
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes, summary: 's' })).rejects.toMatchObject({ code: 'push_failed' });
      github.api.setBranch.mockResolvedValue(undefined);
      github.api.createPullRequest.mockRejectedValue(new Error('422'));
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes, summary: 's' })).rejects.toBeInstanceOf(RepoPublishError);
      github.mint.mockRejectedValue(new Error('403'));
      await expect(service.publish(RUN, repoRow as never, { parentSha: BASE, changes, summary: 's' })).rejects.toMatchObject({ code: 'token_mint_failed' });
      expect(github.revoke).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ConnectorGithub token requests', () => {
  it('asks GitHub for a token on one repository with exactly the given permissions, and revokes with DELETE /installation/token', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const fetchFn = vi.fn().mockImplementation(async (url: string, init: RequestInit) =>
      init.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2030-01-01T00:00:00Z' }), { status: 201 }),
    );
    const config = { get: (k: string) => ({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem })[k] };
    const github = new ConnectorGithub(config as never, {} as never, { fetchFn: fetchFn as never });
    expect(github.configured()).toBe(true);
    await github.mint(7, 'app', { contents: 'write', pull_requests: 'write' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/installations/7/access_tokens');
    expect(JSON.parse(init.body)).toEqual({ repositories: ['app'], permissions: { contents: 'write', pull_requests: 'write' } });
    await github.revoke('ghs_x');
    expect(fetchFn.mock.calls[1][0]).toBe('https://api.github.com/installation/token');
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('redactSecrets for GitHub installation tokens', () => {
  it('scrubs ghs_ tokens and fine-grained tokens anywhere in a reply', () => {
    const text = `clone failed: https://x-access-token:ghs_${'Zz9'.repeat(12)}@github.com/a/b and github_pat_${'A1b2'.repeat(10)}`;
    const out = redactSecrets(text);
    expect(out).not.toMatch(/ghs_|github_pat_/);
    expect(out).toContain('[redacted]');
  });
});
