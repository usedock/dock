'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getDefaultApi } from '@/lib/dock-api';
import type { Organization, Workspace } from '@/lib/dock-api';

interface OrgContextValue {
  organizations: Organization[];
  workspaces: Workspace[];
  selectedOrgId: string | null;
  selectedWorkspaceId: string | null;
  selectOrg: (id: string) => void;
  selectWorkspace: (id: string) => void;
  /** Re-reads the selected org's workspaces after a create, rename, or delete. */
  reloadWorkspaces: () => void;
  loading: boolean;
}

const OrgContext = createContext<OrgContextValue | null>(null);

const ORG_KEY = 'dock:selected-org';
const WORKSPACE_KEY = 'dock:selected-workspace';

/** Workspace/org scope for dashboard lists. Runs and installs require it. */
export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [api] = useState(getDefaultApi);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Loaders only settle state from async continuations; the loading flag
  // starts true and org switches re-arm it in the select handler below.
  const loadOrganizations = useCallback(() => {
    let cancelled = false;
    api
      .listOrganizations()
      .then((orgs) => {
        if (cancelled) return;
        setOrganizations(orgs);
        const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(ORG_KEY);
        const next = orgs.some((o) => o.id === stored) ? (stored as string) : (orgs[0]?.id ?? null);
        setSelectedOrgId(next);
        if (!next) {
          setWorkspaces([]);
          setSelectedWorkspaceId(null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadWorkspaces = useCallback(
    (orgId: string) => {
      let cancelled = false;
      api
        .listWorkspaces(orgId)
        .then((rows) => {
          if (cancelled) return;
          setWorkspaces(rows);
          const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(WORKSPACE_KEY);
          const next = rows.some((w) => w.id === stored) ? (stored as string) : (rows[0]?.id ?? null);
          setSelectedWorkspaceId(next);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) {
            setWorkspaces([]);
            setSelectedWorkspaceId(null);
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    },
    [api],
  );

  useEffect(() => loadOrganizations(), [loadOrganizations]);

  useEffect(() => {
    if (!selectedOrgId) return;
    return loadWorkspaces(selectedOrgId);
  }, [loadWorkspaces, selectedOrgId]);

  const selectOrg = useCallback((id: string) => {
    window.localStorage.setItem(ORG_KEY, id);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
    setLoading(true);
    setSelectedOrgId(id);
  }, []);

  const selectWorkspace = useCallback((id: string) => {
    window.localStorage.setItem(WORKSPACE_KEY, id);
    setSelectedWorkspaceId(id);
  }, []);

  const reloadWorkspaces = useCallback(() => {
    if (selectedOrgId) loadWorkspaces(selectedOrgId);
  }, [loadWorkspaces, selectedOrgId]);

  const value = useMemo(
    () => ({
      organizations,
      workspaces,
      selectedOrgId,
      selectedWorkspaceId,
      selectOrg,
      selectWorkspace,
      reloadWorkspaces,
      loading,
    }),
    [organizations, workspaces, selectedOrgId, selectedWorkspaceId, selectOrg, selectWorkspace, reloadWorkspaces, loading],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within OrgProvider.');
  return ctx;
}
