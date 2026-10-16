import { describe, expect, it } from 'vitest';
import { dockCountLabel, providerLabel, resolveEnvTab } from './environment-view';

describe('resolveEnvTab', () => {
  it('keeps the documented tab values', () => {
    for (const tab of ['repos', 'vars', 'settings', 'versions', 'secrets']) expect(resolveEnvTab(tab)).toBe(tab);
  });

  it('maps friendly aliases', () => {
    expect(resolveEnvTab('variables')).toBe('vars');
    expect(resolveEnvTab('Repositories')).toBe('repos');
    expect(resolveEnvTab('reveal')).toBe('secrets');
  });

  it('falls back to the first tab', () => {
    expect(resolveEnvTab('nope')).toBe('repos');
    expect(resolveEnvTab(null)).toBe('repos');
  });
});

describe('providerLabel', () => {
  it('capitalizes known providers and passes others through', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('gitlab')).toBe('GitLab');
    expect(providerLabel('other')).toBe('other');
  });
});

describe('dockCountLabel', () => {
  it('pluralizes', () => {
    expect(dockCountLabel(1)).toBe('1 dock');
    expect(dockCountLabel(0)).toBe('0 docks');
    expect(dockCountLabel(3)).toBe('3 docks');
  });
});
