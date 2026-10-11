/** Minimal GitHub surface the run lifecycle needs; HttpGithubApi is the only production driver. */
export interface GithubApi {
  createIssueComment(input: {
    token: string;
    owner: string;
    repo: string;
    issue: number;
    body: string;
  }): Promise<{ id: number }>;
  getBranchHead(input: { token: string; owner: string; repo: string; branch: string }): Promise<{ sha: string }>;
  createPullRequest(input: {
    token: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }>;
  getCommitTree(input: { token: string; owner: string; repo: string; sha: string }): Promise<{ treeSha: string }>;
  createBlob(input: { token: string; owner: string; repo: string; contentBase64: string }): Promise<{ sha: string }>;
  createTree(input: { token: string; owner: string; repo: string; baseTree: string; entries: GitTreeEntry[] }): Promise<{ sha: string }>;
  createCommit(input: { token: string; owner: string; repo: string; message: string; tree: string; parents: string[] }): Promise<{ sha: string }>;
  /** Creates the branch, or fast-forwards it; never forces. */
  setBranch(input: { token: string; owner: string; repo: string; branch: string; sha: string; create: boolean }): Promise<void>;
  getRepoFile(input: {
    token: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<{ content: string | null }>;
  /** The repository's default branch name. */
  getDefaultBranch(input: { token: string; owner: string; repo: string }): Promise<string>;
  /** Full names of every repository the installation token can reach. */
  listInstallationRepositories(input: { token: string }): Promise<string[]>;
  /** Effective repo permission (admin, maintain, write, triage, read, none). */
  getCollaboratorPermission(input: { token: string; owner: string; repo: string; username: string }): Promise<{ permission: string }>;
}

/** One tree change; `sha: null` deletes the path. */
export interface GitTreeEntry {
  path: string;
  mode: '100644' | '100755' | '120000';
  type: 'blob';
  sha: string | null;
}

export const GITHUB_API = 'GITHUB_API';
export const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 15_000;
const REPOS_MAX_PAGES = 50;

async function githubFetch(
  fetchFn: typeof fetch,
  token: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const res = await fetchFn(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`github api ${path} failed with status ${res.status}`);
  if (res.status === 204) return null;
  return res.json() as Promise<unknown>;
}

/** Control-plane GitHub client. Always called with short-lived installation tokens, never the App JWT. */
export class HttpGithubApi implements GithubApi {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async createIssueComment(input: { token: string; owner: string; repo: string; issue: number; body: string }) {
    const data = (await githubFetch(this.fetchFn, input.token, `/repos/${input.owner}/${input.repo}/issues/${input.issue}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body }),
    })) as { id?: unknown };
    return { id: typeof data.id === 'number' ? data.id : 0 };
  }

  async getBranchHead(input: { token: string; owner: string; repo: string; branch: string }) {
    const data = (await githubFetch(this.fetchFn, input.token, `/repos/${input.owner}/${input.repo}/git/ref/heads/${input.branch}`, {
      method: 'GET',
    })) as { object?: { sha?: unknown } };
    if (typeof data.object?.sha !== 'string') throw new Error('github api returned no head sha');
    return { sha: data.object.sha };
  }

  async createPullRequest(input: {
    token: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }) {
    const data = (await githubFetch(this.fetchFn, input.token, `/repos/${input.owner}/${input.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft }),
    })) as { number?: unknown; html_url?: unknown };
    if (typeof data.number !== 'number') throw new Error('github api returned no pull request');
    return { number: data.number, url: typeof data.html_url === 'string' ? data.html_url : '' };
  }

  async getCommitTree(input: { token: string; owner: string; repo: string; sha: string }) {
    const data = (await githubFetch(this.fetchFn, input.token, `/repos/${input.owner}/${input.repo}/git/commits/${input.sha}`, {
      method: 'GET',
    })) as { tree?: { sha?: unknown } };
    if (typeof data.tree?.sha !== 'string') throw new Error('github api returned no tree');
    return { treeSha: data.tree.sha };
  }

  async createBlob(input: { token: string; owner: string; repo: string; contentBase64: string }) {
    return this.created(input.token, `/repos/${input.owner}/${input.repo}/git/blobs`, { content: input.contentBase64, encoding: 'base64' });
  }

  async createTree(input: { token: string; owner: string; repo: string; baseTree: string; entries: GitTreeEntry[] }) {
    return this.created(input.token, `/repos/${input.owner}/${input.repo}/git/trees`, { base_tree: input.baseTree, tree: input.entries });
  }

  async createCommit(input: { token: string; owner: string; repo: string; message: string; tree: string; parents: string[] }) {
    return this.created(input.token, `/repos/${input.owner}/${input.repo}/git/commits`, {
      message: input.message,
      tree: input.tree,
      parents: input.parents,
    });
  }

  async setBranch(input: { token: string; owner: string; repo: string; branch: string; sha: string; create: boolean }) {
    const base = `/repos/${input.owner}/${input.repo}/git/refs`;
    if (input.create) {
      await githubFetch(this.fetchFn, input.token, base, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.sha }) });
      return;
    }
    await githubFetch(this.fetchFn, input.token, `${base}/heads/${input.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: input.sha, force: false }),
    });
  }

  private async created(token: string, path: string, body: unknown): Promise<{ sha: string }> {
    const data = (await githubFetch(this.fetchFn, token, path, { method: 'POST', body: JSON.stringify(body) })) as { sha?: unknown };
    if (typeof data.sha !== 'string') throw new Error(`github api ${path} returned no sha`);
    return { sha: data.sha };
  }

  async getDefaultBranch(input: { token: string; owner: string; repo: string }) {
    const data = (await githubFetch(this.fetchFn, input.token, `/repos/${input.owner}/${input.repo}`, { method: 'GET', signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) })) as {
      default_branch?: unknown;
    };
    if (typeof data.default_branch !== 'string' || !data.default_branch) throw new Error('github api returned no default branch');
    return data.default_branch;
  }

  async listInstallationRepositories(input: { token: string }) {
    const names: string[] = [];
    for (let page = 1; page <= REPOS_MAX_PAGES; page += 1) {
      const data = (await githubFetch(this.fetchFn, input.token, `/installation/repositories?per_page=100&page=${page}`, {
        method: 'GET',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })) as { repositories?: Array<{ full_name?: unknown }> };
      const list = data.repositories ?? [];
      for (const r of list) if (typeof r.full_name === 'string') names.push(r.full_name);
      if (list.length < 100) break;
    }
    return names;
  }

  async getCollaboratorPermission(input: { token: string; owner: string; repo: string; username: string }) {
    const res = await this.fetchFn(
      `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/collaborators/${encodeURIComponent(input.username)}/permission`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${input.token}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      },
    );
    if (res.status === 404) return { permission: 'none' };
    if (!res.ok) throw new Error(`github api collaborator permission failed with status ${res.status}`);
    const data = (await res.json()) as { permission?: unknown };
    return { permission: typeof data.permission === 'string' ? data.permission : 'none' };
  }

  async getRepoFile(input: { token: string; owner: string; repo: string; path: string; ref: string }) {
    const res = await this.fetchFn(
      `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(input.ref)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (res.status === 404) return { content: null };
    if (!res.ok) throw new Error(`github api contents failed with status ${res.status}`);
    const data = (await res.json()) as { content?: unknown; encoding?: unknown };
    if (typeof data.content !== 'string') return { content: null };
    const encoding = typeof data.encoding === 'string' ? data.encoding : 'base64';
    if (encoding !== 'base64') return { content: data.content };
    return { content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8') };
  }
}
