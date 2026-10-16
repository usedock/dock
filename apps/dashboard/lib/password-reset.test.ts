import { describe, expect, it } from 'vitest';
import { readResetParams, resetPasswordRedirectTo } from './password-reset';

describe('resetPasswordRedirectTo', () => {
  it('points at the dashboard reset page', () => {
    expect(resetPasswordRedirectTo('https://dock.example.com')).toBe('https://dock.example.com/auth/reset-password');
  });
});

describe('readResetParams', () => {
  it('accepts a token', () => {
    expect(readResetParams({ token: 'abc' })).toEqual({ token: 'abc', failed: false });
    expect(readResetParams({ token: ['abc', 'x'] })).toEqual({ token: 'abc', failed: false });
  });

  it('fails without a token', () => {
    expect(readResetParams({}).failed).toBe(true);
    expect(readResetParams({ token: '' }).failed).toBe(true);
  });

  it('fails on an error even with a token', () => {
    expect(readResetParams({ error: 'INVALID_TOKEN' }).failed).toBe(true);
    expect(readResetParams({ token: 'abc', error: 'INVALID_TOKEN' }).failed).toBe(true);
  });
});
