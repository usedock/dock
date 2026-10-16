import { describe, expect, it } from 'vitest';
import { pageTitle } from './page-title';

describe('pageTitle', () => {
  it('names list and detail routes', () => {
    expect(pageTitle('/docks')).toBe('Docks | Dock Dashboard');
    expect(pageTitle('/docks/dock_1')).toBe('Dock | Dock Dashboard');
    expect(pageTitle('/snapshots')).toBe('Snapshots & Templates | Dock Dashboard');
  });

  it('names nested sections by their own page', () => {
    expect(pageTitle('/developers/api-keys')).toBe('API keys | Dock Dashboard');
    expect(pageTitle('/settings/workspaces')).toBe('Workspaces | Dock Dashboard');
    expect(pageTitle('/settings')).toBe('Settings | Dock Dashboard');
  });

  it('names auth pages and tolerates a trailing slash', () => {
    expect(pageTitle('/auth/login')).toBe('Sign in | Dock Dashboard');
    expect(pageTitle('/auth/signup/')).toBe('Create account | Dock Dashboard');
  });

  it('falls back to the product name', () => {
    expect(pageTitle('/')).toBe('Dock Dashboard');
    expect(pageTitle('/unknown')).toBe('Dock Dashboard');
  });
});
