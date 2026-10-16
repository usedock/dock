import { vi } from 'vitest';
import { credentialedCors } from './cors';

const TRUSTED = 'https://app.example.com';

function run(method: string, origin?: string) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((k: string, v: string) => (headers[k] = v)),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
  const next = vi.fn();
  credentialedCors([TRUSTED])({ method, headers: { origin } } as never, res as never, next);
  return { headers, res, next };
}

describe('credentialedCors', () => {
  it('sets credentialed headers on a trusted GET and continues', () => {
    const { headers, next, res } = run('GET', TRUSTED);
    expect(headers['Access-Control-Allow-Origin']).toBe(TRUSTED);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers['Vary']).toBe('Origin');
    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('answers a trusted preflight with 204', () => {
    const { headers, next, res } = run('OPTIONS', TRUSTED);
    expect(headers['Access-Control-Allow-Methods']).toContain('DELETE');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('adds no headers for an untrusted origin', () => {
    const { res, next } = run('GET', 'https://evil.example.com');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('passes an untrusted preflight through', () => {
    const { res, next } = run('OPTIONS', 'https://evil.example.com');
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
