import { describe, expect, it } from 'vitest';
import { readResetParams, requestResetErrorMessage, resetPasswordRedirectTo } from './password-reset';

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

describe('requestResetErrorMessage', () => {
  it('asks to wait when rate limited', () => {
    expect(requestResetErrorMessage(429)).toBe('Too many requests. Wait a minute and try again.');
  });

  it('asks to retry on any other failure', () => {
    expect(requestResetErrorMessage(403)).toBe('Could not send a reset link. Try again.');
    expect(requestResetErrorMessage(500)).toBe('Could not send a reset link. Try again.');
  });
});
