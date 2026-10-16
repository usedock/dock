import { describe, expect, it } from 'vitest';
import {
  isInvalidTokenError,
  newPasswordProblem,
  readResetParams,
  requestResetErrorMessage,
  resetPasswordRedirectTo,
} from './password-reset';

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

describe('newPasswordProblem', () => {
  const ok = 'a'.repeat(12);

  it('accepts 12 to 128 matching characters', () => {
    expect(newPasswordProblem(ok, ok)).toBeNull();
    expect(newPasswordProblem('a'.repeat(128), 'a'.repeat(128))).toBeNull();
  });

  it('rejects too short and too long passwords', () => {
    expect(newPasswordProblem('a'.repeat(11), 'a'.repeat(11))).toBe('Password must be at least 12 characters.');
    expect(newPasswordProblem('a'.repeat(129), 'a'.repeat(129))).toBe('Password must be at most 128 characters.');
  });

  it('rejects a mismatched confirmation', () => {
    expect(newPasswordProblem(ok, `${ok}b`)).toBe('Passwords do not match.');
  });
});

describe('isInvalidTokenError', () => {
  it('is true only for INVALID_TOKEN', () => {
    expect(isInvalidTokenError({ code: 'INVALID_TOKEN' })).toBe(true);
    expect(isInvalidTokenError({ code: 'PASSWORD_TOO_LONG' })).toBe(false);
    expect(isInvalidTokenError({})).toBe(false);
  });
});
