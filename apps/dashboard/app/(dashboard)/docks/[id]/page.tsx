'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { apiSnippetBase, getDefaultApi, type Dock, type GithubRun, type Snapshot } from '@/lib/dock-api';
import { dockActions, dockStateLabel } from '@/lib/dock-state';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { formatBytes, formatDate, messageOf, runtimeLabel, sizeLabel } from '@/lib/format';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CodeBlock } from '@/components/dashboard/code-block';
import { CopyButton } from '@/components/dashboard/copy-button';
import { DockExecPanel } from '@/components/dashboard/dock-exec-panel';
import { DockPorts } from '@/components/dashboard/dock-ports';
import { DockSsh } from '@/components/dashboard/dock-ssh';
import { DockStats } from '@/components/dashboard/dock-stats';
import { DockTerminal } from '@/components/dashboard/dock-terminal';
import { SaveTemplateDialog } from '@/components/dashboard/save-template-dialog';
import { SnapshotFilesDialog } from '@/components/dashboard/snapshot-files-dialog';
import { StatePill } from '@/components/dashboard/status-pill';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TABS = ['overview', 'terminal', 'connect', 'keys', 'ports', 'snapshots', 'stats'] as const;
const EXEC_STATES = ['ready', 'idle', 'running'];
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.usedock.io';

function Detail({ label, value, mono, copy }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`flex items-center gap-0.5 text-sm ${mono ? 'font-mono' : ''}`}>
        {value}
        {copy && value !== '—' ? <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} /> : null}
      </dd>
    </div>
  );
}

function DockDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const [api] = useState(getDefaultApi);
  const billingOn = useInstanceConfig()?.billingEnabled !== false;

  const tab = params.get('tab') ?? 'overview';
  // Mounted on first visit and kept, so switching tabs does not hang the shell up.
  const [terminalVisited, setTerminalVisited] = useState(false);
  if (tab === 'terminal' && !terminalVisited) setTerminalVisited(true);
  const [dock, setDock] = useState<Dock | null>(null);
  const [run, setRun] = useState<GithubRun | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [statsWindow, setStatsWindow] = useState<'1h' | '24h'>('1h');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);

  const setTab = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('tab', value);
      router.replace(`/docks/${id}?${next.toString()}`);
    },
    [id, params, router],
  );

  const refresh = useCallback(() => {
    api
      .getDock(id)
      .then((d) => {
        setDock(d);
        setError(null);
        if (d.workspaceId) {
          api
            .listRuns(d.workspaceId)
            .then((rows) => setRun(rows.find((r) => r.dockId === id) ?? null))
            .catch(() => setRun(null));
        }
      })
      .catch((e: unknown) => setError(messageOf(e, 'Could not load dock.')));
    api
      .listDockSnapshots(id)
      .then((rows) => setSnapshots(rows))
      .catch(() => setSnapshots([]));
  }, [api, id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runAction(fn: () => Promise<unknown>, failure: string) {
    setActionError(null);
    try {
      await fn();
      refresh();
      return true;
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
      return false;
    }
  }

  async function branch() {
    setActionError(null);
    try {
      const created = (await api.branchDock(id)) as Dock;
      router.push(`/docks/${created.id}`);
    } catch (e: unknown) {
      setActionError(`Could not branch dock: ${messageOf(e, 'request failed')}`);
    }
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Dock" />
        <ErrorNote message={error} onRetry={refresh} />
      </div>
    );
  }
  if (!dock) return <LoadingRows />;

  const fromRun = run !== null;
  const actions = dockActions(dock.state);
  const dockRef = dock.name || dock.id;
  const execBlocked = fromRun
    ? 'This dock is driven by its run. Branch it to run commands.'
    : !EXEC_STATES.includes(dock.state)
      ? `Commands run only on ready docks; this dock is ${dockStateLabel(dock.state)}.`
      : dock.billingPausedAt
        ? 'Billing is paused. Retry the last action.'
        : null;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/docks" />}>Docks</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{dock.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageHeader
        title={dock.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
            Dock <span className="font-mono break-all">{dock.id}</span>
            <CopyButton value={dock.id} label="Copy dock ID" />
          </span>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={dock.state} />
            {!fromRun && actions.canResume ? (
              <Button type="button" variant="outline" size="sm" onClick={() => runAction(() => api.resumeDock(id), 'Could not resume dock')}>
                Resume
              </Button>
            ) : null}
            {!fromRun && actions.canStop ? (
              <Button type="button" variant="outline" size="sm" onClick={() => runAction(() => api.stopDock(id), 'Could not stop dock')}>
                Stop
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" disabled={!actions.canBranch} onClick={branch}>
              Branch
            </Button>
            {!fromRun ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setSavingTemplate(true)}>
                Save template
              </Button>
            ) : null}
            <Button type="button" variant="destructive" size="sm" className="ml-2" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        }
      />
      {actionError ? <ErrorNote message={actionError} /> : null}

      <Tabs value={TABS.includes(tab as (typeof TABS)[number]) ? tab : 'overview'} onValueChange={setTab}>
        <TabsList aria-label="Dock sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="connect">Connect</TabsTrigger>
          <TabsTrigger value="keys">SSH</TabsTrigger>
          <TabsTrigger value="ports">Ports</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-3">
            <Detail label="State" value={dockStateLabel(dock.state)} />
            <Detail label="Size" value={sizeLabel(dock)} />
            <Detail label="Runtime" value={runtimeLabel(dock.runtime)} />
            <Detail
              label="Persisted"
              value={
                dock.runtime === 'gvisor'
                  ? `Keeps ${(dock.persistentPaths ?? ['/home/user/work']).join(', ')} across stops`
                  : dock.runtime === 'microvm'
                    ? 'Whole disk persists across stops'
                    : '—'
              }
            />
            <Detail label="Environment" value={dock.environment ?? 'base'} mono />
            <Detail label="IP" value={dock.ip ?? '—'} mono copy />
            <Detail label="Host" value={dock.hostId ?? '—'} mono copy />
            <Detail label="Setup" value={dock.setupStatus ?? 'pending'} />
            {billingOn ? <Detail label="Cost" value={dock.billingPausedAt ? 'Paused' : 'Metered'} /> : null}
            <Detail label="Created" value={formatDate(dock.createdAt)} />
          </dl>
          {dock.setupError ? <ErrorNote message={dock.setupError} /> : null}
          <section className="flex flex-col gap-2" aria-labelledby="dock-usage">
            <h2 id="dock-usage" className="text-sm font-medium">Usage</h2>
            <DockStats api={api} dockId={dock.id} window="1h" />
          </section>
          {run ? (
            <p className="text-sm text-muted-foreground">
              Provisioned by <Link href={`/runs/${run.id}`} className="underline underline-offset-4">run {run.id.slice(0, 8)}</Link>
              {run.prNumber ? (
                <>
                  {' '}for {run.repo}#{run.issueNumber}{run.prUrl ? (
                    <>
                      {' '}→ <a href={run.prUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">PR #{run.prNumber}</a>
                    </>
                  ) : (
                    <> → PR #{run.prNumber}</>
                  )}
                </>
              ) : (
                <> for {run.repo}#{run.issueNumber}</>
              )}
              . It stops when the run completes; branch it to keep working.
            </p>
          ) : null}
          <DockExecPanel api={api} dockId={dock.id} disabledReason={execBlocked} />
        </TabsContent>

        <TabsContent value="terminal" keepMounted={terminalVisited}>
          {execBlocked ? (
            <EmptyNote title="The terminal is unavailable." hint={execBlocked} />
          ) : terminalVisited ? (
            <DockTerminal api={api} dockId={dock.id} />
          ) : null}
        </TabsContent>

        <TabsContent value="connect" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">CLI</h2>
            <CodeBlock lines={[`dock exec ${dockRef} -- uname -a`, `dock ssh ${dockRef}`]} />
            <p className="text-sm text-muted-foreground">
              Sign in once with <code className="font-mono">dock login</code>.{' '}
              <a href={`${DOCS_URL}/cli`} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                CLI docs
              </a>
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">API</h2>
            <CodeBlock
              lines={[
                '# run a command',
                `curl -X POST ${apiSnippetBase()}/v1/docks/${dock.id}/exec \\`,
                '  -H "Authorization: Bearer $DOCK_API_KEY" \\',
                '  -H "Content-Type: application/json" \\',
                `  -d '{"command": "uname -a", "timeoutSeconds": 60}'`,
                '',
                '# resume',
                `curl -X POST ${apiSnippetBase()}/v1/docks/${dock.id}/resume \\`,
                '  -H "Authorization: Bearer $DOCK_API_KEY"',
                '',
                '# stop',
                `curl -X POST ${apiSnippetBase()}/v1/docks/${dock.id}/stop \\`,
                '  -H "Authorization: Bearer $DOCK_API_KEY"',
              ]}
            />
          </div>
        </TabsContent>

        <TabsContent value="keys" className="flex flex-col gap-4">
          <DockSsh dockId={dock.id} blocked={execBlocked} />
        </TabsContent>

        <TabsContent value="ports" className="flex flex-col gap-4">
          <DockPorts api={api} dockId={dock.id} running={EXEC_STATES.includes(dock.state) && !dock.billingPausedAt} />
        </TabsContent>

        <TabsContent value="snapshots" className="flex flex-col gap-3">
          {snapshots === null ? (
            <LoadingRows rows={3} />
          ) : snapshots.length === 0 ? (
            <EmptyNote title="No snapshots yet." hint="Snapshots capture this dock's filesystem for resume and branching." />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshots.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.id.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge variant={s.status === 'failed' ? 'destructive' : 'secondary'}>{s.status ?? 'completed'}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{formatBytes(s.sizeBytes)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={s.status !== undefined && s.status !== 'completed'}
                          onClick={() => setBrowsing(s.id)}
                        >
                          Browse
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="stats" className="flex flex-col gap-3">
          <Tabs value={statsWindow} onValueChange={(v) => setStatsWindow(v as '1h' | '24h')}>
            <TabsList aria-label="Stats window">
              <TabsTrigger value="1h">1h</TabsTrigger>
              <TabsTrigger value="24h">24h</TabsTrigger>
            </TabsList>
          </Tabs>
          <DockStats api={api} dockId={dock.id} window={statsWindow} />
        </TabsContent>
      </Tabs>

      <SnapshotFilesDialog api={api} snapshotId={browsing} onOpenChange={(open) => !open && setBrowsing(null)} />
      <SaveTemplateDialog
        api={api}
        docks={[dock]}
        open={savingTemplate}
        onOpenChange={setSavingTemplate}
        onSaved={() => router.push('/snapshots?tab=templates')}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {dock.name}?</DialogTitle>
            <DialogDescription>Deleting is async and permanent. Captured snapshots are kept separately.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                runAction(() => api.deleteDock(id), 'Could not delete dock').then((ok) => ok && router.push('/docks'));
              }}
            >
              Delete dock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DockDetailPage() {
  return (
    <Suspense>
      <DockDetail />
    </Suspense>
  );
}
