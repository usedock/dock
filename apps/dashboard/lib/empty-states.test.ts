import { describe, expect, it } from 'vitest';
import { isAccountClosed, isEmailVerificationRequired, notificationsCopy, runsEmptyHint, visibleAccountActions } from './empty-states';

describe('error codes', () => {
  it('detects the unverified-email and closed-account codes only', () => {
    expect(isEmailVerificationRequired({ code: 'email_verification_required' })).toBe(true);
    expect(isEmailVerificationRequired(new Error('x'))).toBe(false);
    expect(isEmailVerificationRequired(null)).toBe(false);
    expect(isAccountClosed({ code: 'account_closed' })).toBe(true);
    expect(isAccountClosed({ code: 'forbidden' })).toBe(false);
  });
});

describe('visibleAccountActions', () => {
  it('offers reopen only to a closed account and close only to an open one', () => {
    expect(visibleAccountActions(false)).toEqual(['close', 'erase']);
    expect(visibleAccountActions(true)).toEqual(['reopen', 'erase']);
  });
});

describe('runsEmptyHint', () => {
  it('points at GitHub setup only when no installation is linked', () => {
    expect(runsEmptyHint(false).href).toBe('/developers/github');
    expect(runsEmptyHint(true).href).toBeUndefined();
    expect(runsEmptyHint(null).text).toContain('@dock');
  });
});

describe('notificationsCopy', () => {
  it('drops billing wording when billing is off', () => {
    expect(JSON.stringify(notificationsCopy(false)).toLowerCase()).not.toContain('billing');
    expect(JSON.stringify(notificationsCopy(true)).toLowerCase()).toContain('billing');
  });
});
