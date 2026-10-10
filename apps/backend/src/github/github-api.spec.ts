import { HttpGithubApi } from './github-api';
import { vi } from 'vitest';

function api(responses: Array<{ status?: number; body?: unknown }>) {
  const fetchFn = vi.fn().mockImplementation(() => {
    const next = responses.shift() ?? {};
    const status = next.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(next.body ?? {}) });
  });
  return { client: new HttpGithubApi(fetchFn as never), fetchFn };
}

const call = (fetchFn: ReturnType<typeof vi.fn>, i: number) => {
  const [url, init] = fetchFn.mock.calls[i];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization };
};

describe('HttpGithubApi git data', () => {
  it('builds blob, tree, and commit through the Git Data API with the given token', async () => {
    const { client, fetchFn } = api([{ body: { sha: 'b1' } }, { body: { sha: 't1' } }, { body: { sha: 'c1' } }, { body: { tree: { sha: 'base-tree' } } }]);
    const base = { token: 'ghs_rw', owner: 'acme', repo: 'web' };
    expect(await client.createBlob({ ...base, contentBase64: 'aGk=' })).toEqual({ sha: 'b1' });
    expect(await client.createTree({ ...base, baseTree: 'bt', entries: [{ path: 'a', mode: '100644', type: 'blob', sha: null }] })).toEqual({ sha: 't1' });
    expect(await client.createCommit({ ...base, message: 'm', tree: 't1', parents: ['p'] })).toEqual({ sha: 'c1' });
    expect(await client.getCommitTree({ ...base, sha: 'p' })).toEqual({ treeSha: 'base-tree' });
    expect(call(fetchFn, 0)).toEqual({ url: 'https://api.github.com/repos/acme/web/git/blobs', method: 'POST', body: { content: 'aGk=', encoding: 'base64' }, auth: 'Bearer ghs_rw' });
    expect(call(fetchFn, 1).body).toEqual({ base_tree: 'bt', tree: [{ path: 'a', mode: '100644', type: 'blob', sha: null }] });
    expect(call(fetchFn, 2).body).toEqual({ message: 'm', tree: 't1', parents: ['p'] });
    expect(call(fetchFn, 3)).toMatchObject({ url: 'https://api.github.com/repos/acme/web/git/commits/p', method: 'GET' });
  });

  it('creates new branches and fast-forwards existing ones, never forcing', async () => {
    const { client, fetchFn } = api([{ status: 201 }, { status: 200 }]);
    const base = { token: 't', owner: 'acme', repo: 'web', branch: 'dock/run-1', sha: 'c1' };
    await client.setBranch({ ...base, create: true });
    await client.setBranch({ ...base, create: false });
    expect(call(fetchFn, 0)).toMatchObject({ url: 'https://api.github.com/repos/acme/web/git/refs', method: 'POST', body: { ref: 'refs/heads/dock/run-1', sha: 'c1' } });
    expect(call(fetchFn, 1)).toMatchObject({ url: 'https://api.github.com/repos/acme/web/git/refs/heads/dock/run-1', method: 'PATCH', body: { sha: 'c1', force: false } });
  });

  it('surfaces GitHub refusals and missing shas as errors', async () => {
    const { client } = api([{ status: 422 }, { body: {} }]);
    await expect(client.setBranch({ token: 't', owner: 'a', repo: 'b', branch: 'x', sha: 's', create: false })).rejects.toThrow('status 422');
    await expect(client.createBlob({ token: 't', owner: 'a', repo: 'b', contentBase64: '' })).rejects.toThrow('returned no sha');
  });
});
