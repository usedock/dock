'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getDefaultApi, type Dock, type GithubRun, type HostSummary } from '@/lib/dock-api';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { useOrg } from '@/components/dashboard/org-context';
import { PageHeader } from '@/components/dashboard/data-states';
import { Button } from '@/components/ui/button';
import { gettingStarted } from '@/lib/home-summary';
import { StatStrip } from './stat-strip';
import { RecentDocks } from './recent-docks';
import { RecentRuns } from './recent-runs';
import { GettingStarted } from './getting-started';
import { HostsGroup } from './hosts-group';

/** Each section settles on its own: null while loading, 'error' when its call failed. */
export type Section<T> = T | null | 'error';

function useSection<T>(load: (() => Promise<T>) | null, scope: string): Section<T> {
  const [state, setState] = useState<{ scope: string; value: Section<T> }>({ scope: '', value: null });
  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then(
      (value) => live && setState({ scope, value }),
      () => live && setState({ scope, value: 'error' }),
    );
    return () => {
      live = false;
    };
    // load is rebuilt each render; scope carries its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  return state.scope === scope ? state.value : null;
}

export function Home() {
  const { selectedOrgId, selectedWorkspaceId, workspaces } = useOrg();
  const config = useInstanceConfig();
  const [api] = useState(getDefaultApi);
  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  const docks = useSection<Dock[]>(() => api.listDocks(undefined, true), 'all');
  const runs = useSection<GithubRun[]>(
    selectedWorkspaceId ? () => api.listRuns(selectedWorkspaceId) : null,
    selectedWorkspaceId ?? '-',
  );
  const sshKeys = useSection(() => api.listSshKeys(), 'all');
  const installs = useSection(
    selectedWorkspaceId ? () => api.listInstallations(selectedWorkspaceId) : null,
    selectedWorkspaceId ?? '-',
  );
  const environments = useSection(selectedOrgId ? () => api.listEnvironments(selectedOrgId) : null, selectedOrgId ?? '-');
  const hosts = useSection<HostSummary[]>(() => api.listHosts(), 'all');

  const count = (s: Section<unknown[]>) => (Array.isArray(s) ? s.length : null);
  const githubLinked = config?.githubAppConfigured === false ? null : Array.isArray(installs) ? installs.length > 0 : null;
  const checklist = gettingStarted({
    docks: count(docks),
    sshKeys: count(sshKeys),
    githubLinked,
    environments: count(environments),
  });
  const checklistReady = docks !== null && sshKeys !== null && installs !== null && environments !== null;

  const showRuns = runs === null || (Array.isArray(runs) && runs.length > 0);
  const showHosts = Array.isArray(hosts) && hosts.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Home"
        description={`${workspace ? `${workspace.name}. ` : ''}Your docks, runs and setup at a glance.`}
        action={
          <Button size="sm" nativeButton={false} render={<Link href="/docks?new=1" />}>
            <Plus />
            New dock
          </Button>
        }
      />
      <StatStrip docks={docks} />
      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <RecentDocks docks={docks} />
        <div className="flex flex-col gap-8">
          {showRuns ? <RecentRuns runs={runs} /> : null}
          {checklistReady && !checklist.allDone ? <GettingStarted items={checklist.items} /> : null}
          {showHosts ? <HostsGroup hosts={hosts} /> : null}
        </div>
      </div>
    </div>
  );
}
