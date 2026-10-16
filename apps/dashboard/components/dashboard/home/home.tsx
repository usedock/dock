'use client';

import { useEffect, useState } from 'react';
import { getDefaultApi, type Dock, type GithubRun, type HostSummary } from '@/lib/dock-api';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { useOrg } from '@/components/dashboard/org-context';
import { PageHeader } from '@/components/dashboard/data-states';
import { gettingStarted, sectionValue, type Section } from '@/lib/home-summary';
import { StatStrip } from './stat-strip';
import { RecentDocks } from './recent-docks';
import { RecentRuns } from './recent-runs';
import { GettingStarted } from './getting-started';
import { HostsGroup } from './hosts-group';

function useSection<T>(scope: string | null, load: (scope: string) => Promise<T>, pending = false): Section<T> {
  const [state, setState] = useState<{ scope: string; value: Section<T> }>({ scope: '', value: null });
  useEffect(() => {
    if (scope === null) return;
    let live = true;
    load(scope).then(
      (value) => live && setState({ scope, value }),
      () => live && setState({ scope, value: 'error' }),
    );
    return () => {
      live = false;
    };
    // load is rebuilt each render; scope carries its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  return sectionValue(state, scope, pending);
}

export function Home() {
  const { selectedOrgId, selectedWorkspaceId, loading: orgLoading } = useOrg();
  const config = useInstanceConfig();
  const [api] = useState(getDefaultApi);

  const docks = useSection<Dock[]>('all', () => api.listDocks(undefined, true));
  const runs = useSection<GithubRun[]>(selectedWorkspaceId, (id) => api.listRuns(id), orgLoading);
  const sshKeys = useSection('all', () => api.listSshKeys());
  const installs = useSection(selectedWorkspaceId, (id) => api.listInstallations(id), orgLoading);
  const environments = useSection(selectedOrgId, (id) => api.listEnvironments(id), orgLoading);
  const hosts = useSection<HostSummary[]>('all', () => api.listHosts());

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
      <PageHeader title="Home" description="Your docks, runs and setup at a glance." />
      <StatStrip docks={docks} />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <RecentDocks docks={docks} />
        <div className="flex min-w-0 flex-col gap-8">
          {showRuns ? <RecentRuns runs={runs} /> : null}
          {checklistReady && !checklist.allDone ? <GettingStarted items={checklist.items} /> : null}
          {showHosts ? <HostsGroup hosts={hosts} /> : null}
        </div>
      </div>
    </div>
  );
}
