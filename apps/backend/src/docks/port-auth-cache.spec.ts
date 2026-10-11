import { PortAuthCache } from './port-auth-cache';

describe('PortAuthCache', () => {
  it('remembers a grant until the TTL passes', () => {
    const cache = new PortAuthCache();
    cache.grant('l1', 'cred', 'd1', 1000);
    expect(cache.has('l1', 'cred', 'd1', 1000 + cache.ttlMs - 1)).toBe(true);
    expect(cache.has('l1', 'cred', 'd1', 1000 + cache.ttlMs)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('keys by label, credential and dock', () => {
    const cache = new PortAuthCache();
    cache.grant('l1', 'cred', 'd1', 0);
    expect(cache.has('l2', 'cred', 'd1', 1)).toBe(false);
    expect(cache.has('l1', 'other', 'd1', 1)).toBe(false);
    expect(cache.has('l1', 'cred', 'd2', 1)).toBe(false);
  });

  it('invalidates one label only', () => {
    const cache = new PortAuthCache();
    cache.grant('l1', 'cred', 'd1', 0);
    cache.grant('l2', 'cred', 'd1', 0);
    cache.invalidateLabel('l1');
    expect(cache.has('l1', 'cred', 'd1', 1)).toBe(false);
    expect(cache.has('l2', 'cred', 'd1', 1)).toBe(true);
  });

  it('stays within its size bound, sweeping expired entries before dropping the oldest', () => {
    const cache = new PortAuthCache();
    cache.max = 3;
    cache.grant('l', 'a', 'd', 0);
    cache.grant('l', 'b', 'd', 4000);
    cache.grant('l', 'c', 'd', 4000);
    cache.grant('l', 'd', 'd', 5000);
    expect(cache.size).toBe(3);
    expect(cache.has('l', 'a', 'd', 5000)).toBe(false);
    cache.grant('l', 'e', 'd', 5000);
    expect(cache.size).toBe(3);
    expect(cache.has('l', 'b', 'd', 5000)).toBe(false);
    expect(cache.has('l', 'e', 'd', 5000)).toBe(true);
  });
});
