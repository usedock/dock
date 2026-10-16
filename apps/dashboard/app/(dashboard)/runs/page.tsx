'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDefaultApi, type GithubRun } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
import { runsEmptyHint } from '@/lib/empty-states';
import { RUN_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Tab = 'all' | 'open' | 'review' | 'merged';

const OPEN_STATES = ['pending', 'provisioning', 'working', 'failed', 'stopped'];

function RunsTable() {
  const router = useRouter();
  const params = useSearchParams();
  const { selectedWorkspaceId } = useOrg();
  const [api] = useState(getDefaultApi);

  const tab = (params.get('tab') as Tab) || 'all';
  const query = params.get('q') ?? '';

  const [runs, setRuns] = useState<GithubRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null until known; a failed lookup keeps the default hint.
  const [githubLinked, setGithubLinked] = useState<boolean | null>(null);

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const s = next.toString();
      router.replace(`/runs${s ? `?${s}` : ''}`);
    },
    [params, router],
  );

  // Refresh only settles state from async continuations; the workspace gate
  // in render covers the unscoped case, so no synchronous resets are needed.
  const refresh = useCallback(() => {
    if (!selectedWorkspaceId) return;
    const states =
      tab === 'review' ? ['pr_opened', 'done'] : tab === 'merged' ? ['done'] : tab === 'open' ? OPEN_STATES : [undefined];
    Promise.all(states.map((state) => api.listRuns(selectedWorkspaceId, state)))
      .then((pages) => {
        const merged = new Map<string, GithubRun>();
        // Finished fixes land in done with their PR; review means a PR exists.
        for (const page of pages) for (const run of page) if (tab !== 'review' || run.prUrl) merged.set(run.id, run);
        const sorted = [...merged.values()].sort((a, b) =>
          String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')),
        );
        setRuns(sorted);
        setError(null);
      })
      .catch((e: unknown) => {
        setRuns([]);
        setError(messageOf(e, 'Could not load runs.'));
      });
  }, [api, selectedWorkspaceId, tab]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    api
      .listInstallations(selectedWorkspaceId)
      .then((rows) => setGithubLinked(rows.length > 0))
      .catch(() => setGithubLinked(null));
  }, [api, selectedWorkspaceId]);

  const emptyHint = runsEmptyHint(githubLinked);

  const rows = useMemo(() => {
    const list = runs ?? [];
    if (!query) return list;
    const q = query.toLowerCase();
    return list.filter(
      (r) =>
        r.repo.toLowerCase().includes(q) ||
        String(r.issueNumber).includes(q) ||
        (r.prNumber !== null && r.prNumber !== undefined && String(r.prNumber).includes(q)),
    );
  }, [runs, query]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Runs"
        description="Issue in, pull request out. Every @dock mention execution across the workspace."
      />

      <Tabs value={tab} onValueChange={(v) => setParam('tab', v)}>
        <TabsList aria-label="Run states">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="review">Needs review</TabsTrigger>
          <TabsTrigger value="merged">Merged</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search runs"
          placeholder="Search repo, issue, or PR"
          className="max-w-xs"
          defaultValue={query}
          onChange={(e) => setParam('q', e.target.value)}
        />
      </div>

      {!selectedWorkspaceId ? (
        <EmptyNote title="Pick a workspace." hint="Runs are scoped to a workspace. Select one from the sidebar switcher." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : runs === null ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyNote
          title="No runs here."
          hint={
            <>
              {emptyHint.text}{' '}
              {emptyHint.href ? (
                <Link href={emptyHint.href} className="text-foreground underline underline-offset-4">
                  {emptyHint.linkText}
                </Link>
              ) : null}
            </>
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Issue</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Dock</TableHead>
                <TableHead>PR</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link href={`/runs/${run.id}`} className="font-medium underline-offset-4 hover:underline">
                      {run.repo}#{run.issueNumber}
                    </Link>
                    <div className="flex items-center gap-0.5 text-muted-foreground">
                      <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
                      <CopyButton value={run.id} label="Copy run ID" />
                    </div>
                    {run.failureReason ? (
                      <div className="font-mono text-xs text-destructive">{run.failureReason}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatePill state={run.state} toneMap={RUN_STATE_TONE} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {run.dockId ? (
                      <Link href={`/docks/${run.dockId}`} className="underline-offset-4 hover:underline">
                        {run.dockId.slice(0, 8)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {run.prNumber ? (
                      <a
                        href={run.prUrl ?? undefined}
                        target={run.prUrl ? '_blank' : undefined}
                        rel="noreferrer"
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        #{run.prNumber}
                      </a>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{run.agent ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(run.updatedAt ?? run.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function RunsPage() {
  return (
    <Suspense>
      <RunsTable />
    </Suspense>
  );
}
