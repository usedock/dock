import { bindDockScope, inDockScope, runInDockScope, scopeOrgIds } from './dock-scope';

describe('dock scope', () => {
  it('is open when no org is pinned', () => {
    runInDockScope(() => {
      expect(inDockScope('org-1')).toBe(true);
      expect(scopeOrgIds(['org-1', 'org-2'])).toEqual(['org-1', 'org-2']);
    });
  });

  it('confines a pinned request to one org', () => {
    runInDockScope(() => {
      expect(bindDockScope('org-1')).toBe(true);
      expect(inDockScope('org-1')).toBe(true);
      expect(inDockScope('org-2')).toBe(false);
      expect(scopeOrgIds(['org-1', 'org-2'])).toEqual(['org-1']);
    });
  });

  it('refuses to pin outside a scope', () => {
    expect(bindDockScope('org-1')).toBe(false);
  });
});
