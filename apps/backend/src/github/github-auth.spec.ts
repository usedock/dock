import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { exchangeInstallationToken, mintAppJwt, verifyGithubSignature } from './github-auth';
import { vi } from 'vitest';

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  it('accepts a valid sha256 signature over exact bytes', () => {
    expect(verifyGithubSignature('secret', sign('secret', '{"a":1}'), '{"a":1}')).toBe(true);
  });

  it('rejects reserialized bodies that change bytes', () => {
    expect(verifyGithubSignature('secret', sign('secret', '{"a":1}'), '{"a": 1}')).toBe(false);
  });

  it('rejects missing, malformed, and wrong-key signatures', () => {
    expect(verifyGithubSignature('secret', undefined, 'x')).toBe(false);
    expect(verifyGithubSignature('', sign('secret', 'x'), 'x')).toBe(false);
    expect(verifyGithubSignature('secret', 't=1,v1=abc', 'x')).toBe(false);
    expect(verifyGithubSignature('secret', sign('other', 'x'), 'x')).toBe(false);
    expect(verifyGithubSignature('secret', 'sha256=zzzz', 'x')).toBe(false);
  });
});

describe('mintAppJwt', () => {
  it('mints an RS256 JWT the App key verifies with a 10-minute window', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = Date.now();
    const jwt = mintAppJwt('12345', pem, now);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))).toMatchObject({ alg: 'RS256' });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBe(600);
    const check = createVerify('RSA-SHA256');
    check.update(`${h}.${p}`);
    expect(check.verify(publicKey, s, 'base64url')).toBe(true);
  });
});

describe('exchangeInstallationToken', () => {
  it('posts the JWT and returns the single-repo token', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'ghs_abc', expires_at: '2026-09-08T18:00:00Z' }),
    });
    const out = await exchangeInstallationToken({
      apiBase: 'https://api.github.com',
      jwt: 'app-jwt',
      installationId: 99,
      repositories: ['acme/web'],
      fetchFn: fetchFn as never,
    });
    expect(out).toEqual({ token: 'ghs_abc', expiresAt: '2026-09-08T18:00:00Z' });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/99/access_tokens',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer app-jwt' }),
      }),
    );
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ repositories: ['acme/web'] });
  });

  it('narrows the token when permissions are given', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ token: 'ghs_ro' }) });
    await exchangeInstallationToken({
      apiBase: 'https://api.github.com',
      jwt: 'j',
      installationId: 1,
      repositories: ['web'],
      permissions: { contents: 'read' },
      fetchFn: fetchFn as never,
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ repositories: ['web'], permissions: { contents: 'read' } });
  });

  it('throws without creating state when GitHub refuses the mint', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    await expect(
      exchangeInstallationToken({ apiBase: 'https://api.github.com', jwt: 'j', installationId: 1, repositories: ['a/b'], fetchFn: fetchFn as never }),
    ).rejects.toThrow(/status 401/);
  });
});
