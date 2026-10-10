'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDefaultApi, type Dock, type Snapshot, type Template } from '@/lib/dock-api';
import { formatBytes, formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
import { SaveTemplateDialog } from '@/components/dashboard/save-template-dialog';
import { SnapshotFilesDialog } from '@/components/dashboard/snapshot-files-dialog';
import { Badge } from '@/components/ui/badge';
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

type PendingDelete = { kind: 'snapshot'; id: string } | { kind: 'template'; name: string; organizationId: string };

function DockLink({ id, docks }: { id: string | null | undefined; docks: Map<string, Dock> }) {
  if (!id) return <span className="text-muted-foreground">—</span>;
  const dock = docks.get(id);
  if (!dock) return <span className="font-mono text-xs text-muted-foreground" title="Dock deleted">{id.slice(0, 8)}</span>;
  return (
    <Link href={`/docks/${id}`} className="underline-offset-4 hover:underline">
      {dock.name}
    </Link>
  );
}

/** Saved state: point-in-time snapshots and frozen named templates. */
function SnapshotsBody() {
  const router = useRouter();
  const params = useSearchParams();
  const { selectedWorkspaceId } = useOrg();
  const [api] = useState(getDefaultApi);

  const tab = params.get('tab') === 'templates' ? 'templates' : 'snapshots';
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [docks, setDocks] = useState<Dock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The target outlives the open flag so the dialog keeps its text while closing.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);

  const setTab = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('tab', value);
      router.replace(`/snapshots?${next.toString()}`);
    },
    [params, router],
  );

  // Settles state only from async continuations; render starts unloaded.
  const refresh = useCallback(() => {
    api
      .listSnapshots(undefined, 100)
      .then((rows) => {
        setSnapshots(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setSnapshots([]);
        setError(messageOf(e, 'Could not load snapshots.'));
      });
    api
      .listTemplates()
      .then((rows) => {
        setTemplates(rows);
        setTemplatesError(null);
      })
      .catch((e: unknown) => {
        setTemplates([]);
        setTemplatesError(messageOf(e, 'Could not load templates.'));
      });
    api
      .listDocks(undefined, true)
      .then(setDocks)
      .catch(() => setDocks([]));
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runAction(fn: () => Promise<unknown>, failure: string) {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      refresh();
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
    }
  }

  async function deploy(name: string) {
    if (!selectedWorkspaceId) return;
    setDeploying(name);
    setActionError(null);
    setNotice(null);
    try {
      const dock = await api.createDock({ workspaceId: selectedWorkspaceId, from: name });
      router.push(`/docks/${dock.id}`);
    } catch (e: unknown) {
      setActionError(`Could not deploy ${name}: ${messageOf(e, 'request failed')}`);
      setDeploying(null);
    }
  }

  function askDelete(target: PendingDelete) {
    setPendingDelete(target);
    setDeleteOpen(true);
  }

  function confirmDelete() {
    const target = pendingDelete;
    setDeleteOpen(false);
    if (!target) return;
    if (target.kind === 'snapshot') runAction(() => api.deleteSnapshot(target.id), 'Could not delete snapshot');
    else runAction(() => api.deleteTemplate(target.name, target.organizationId), `Could not delete ${target.name}`);
  }

  const dockById = new Map(docks.map((d) => [d.id, d]));
  const saveable = docks.filter((d) => ['ready', 'idle', 'running', 'archived'].includes(d.state));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Snapshots & Templates"
        description="Snapshots are captured when a dock stops. Templates freeze a dock under a name so new docks can start from it."
        action={
          <Button type="button" variant="outline" onClick={() => setSaving(true)} disabled={!saveable.length}>
            Save template
          </Button>
        }
      />
      {notice ? (
        <p role="status" className="rounded-md border px-4 py-3 text-sm">
          {notice}
        </p>
      ) : null}
      {actionError ? <ErrorNote message={actionError} /> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Saved state">
          <TabsTrigger value="snapshots">Snapshots{snapshots?.length ? ` (${snapshots.length})` : ''}</TabsTrigger>
          <TabsTrigger value="templates">Templates{templates?.length ? ` (${templates.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="snapshots" className="flex flex-col gap-3">
          {error ? <ErrorNote message={error} onRetry={refresh} /> : null}
          {snapshots === null ? (
            <LoadingRows />
          ) : snapshots.length === 0 ? (
            error ? null : (
              <EmptyNote
                title="No snapshots yet."
                hint="Stopping a dock captures its filesystem here. Resume and branch start from the latest one."
              />
            )
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Dock</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshots.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">
                        <span className="inline-flex items-center gap-0.5">
                          {s.id.slice(0, 8)}
                          <CopyButton value={s.id} label="Copy snapshot ID" />
                        </span>
                      </TableCell>
                      <TableCell>
                        <DockLink id={s.dockId} docks={dockById} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.status === 'failed' ? 'destructive' : 'secondary'}>{s.status ?? 'completed'}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{formatBytes(s.sizeBytes)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={s.status !== undefined && s.status !== 'completed'}
                            onClick={() => setBrowsing(s.id)}
                          >
                            Files
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => askDelete({ kind: 'snapshot', id: s.id })}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="templates" className="flex flex-col gap-3">
          {templatesError ? <ErrorNote message={templatesError} onRetry={refresh} /> : null}
          {templates === null ? (
            <LoadingRows />
          ) : templates.length === 0 ? (
            templatesError ? null : (
              <EmptyNote
                title="No templates yet."
                hint="Save a dock as a template, then deploy new docks from it by name. Up to 10 per organization."
              />
            )
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Source dock</TableHead>
                    <TableHead>Saved</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((t) => (
                    <TableRow key={t.name}>
                      <TableCell className="font-mono text-sm">{t.name}</TableCell>
                      <TableCell>
                        <Badge variant={t.status === 'failed' ? 'destructive' : 'secondary'}>{t.status ?? 'ready'}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{formatBytes(t.sizeBytes)}</TableCell>
                      <TableCell>
                        <DockLink id={t.sourceDockId} docks={dockById} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(t.updatedAt ?? t.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!selectedWorkspaceId || t.status !== 'ready' || deploying !== null}
                            title={selectedWorkspaceId ? 'Start a new dock from this template' : 'Select a workspace first'}
                            onClick={() => deploy(t.name)}
                          >
                            {deploying === t.name ? 'Deploying…' : 'Deploy'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => askDelete({ kind: 'template', name: t.name, organizationId: t.organizationId })}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <SnapshotFilesDialog api={api} snapshotId={browsing} onOpenChange={(open) => !open && setBrowsing(null)} />

      <SaveTemplateDialog
        api={api}
        docks={saveable}
        open={saving}
        onOpenChange={setSaving}
        onSaved={(t) => {
          setNotice(`Saved template ${t.name}.`);
          setTab('templates');
          refresh();
        }}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingDelete?.kind === 'template'
                ? `Delete template ${pendingDelete.name}?`
                : `Delete snapshot ${pendingDelete?.kind === 'snapshot' ? pendingDelete.id.slice(0, 8) : ''}?`}
            </DialogTitle>
            <DialogDescription>
              {pendingDelete?.kind === 'template'
                ? 'Docks already deployed from it keep running. New docks can no longer start from this name.'
                : 'The captured files are removed permanently. Snapshots a newer one builds on cannot be deleted.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function SnapshotsPage() {
  return (
    <Suspense>
      <SnapshotsBody />
    </Suspense>
  );
}
