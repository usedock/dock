import { describe, expect, it } from 'vitest';
import {
  cliLoginLines,
  hostEnrollLines,
  isAccountClosed,
  isEmailVerificationRequired,
  notificationsCopy,
  runsEmptyHint,
  visibleAccountActions,
} from './empty-states';

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

describe('hostEnrollLines', () => {
  it('points bootstrap-host.sh at this instance, not a placeholder', () => {
    const lines = hostEnrollLines('https://dock.acme.dev');
    expect(lines).toContain('  --fleet-url https://dock.acme.dev \\');
    const text = lines.join(' ');
    expect(text).not.toContain('example.com');
  });
});

describe('cliLoginLines', () => {
  it('logs in directly against the hosted API', () => {
    expect(cliLoginLines('https://api.usedock.io/')[0]).toBe('dock login');
  });

  it('adds and selects a context first for a self-hosted API, since bare login targets cloud', () => {
    const lines = cliLoginLines('https://dock.acme.dev');
    expect(lines.slice(0, 2)).toEqual(['dock context add dock.acme.dev --url https://dock.acme.dev', 'dock context use dock.acme.dev']);
    expect(lines).toContain('dock login');
  });
});
