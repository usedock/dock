'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { MoreHorizontal, Plus } from 'lucide-react';
import { apiSnippetBase, getDefaultApi, type Connector, type Dock, type DockImage, type Environment, type GithubRun } from '@/lib/dock-api';
import { formatAgo, formatDate, formatDuration, messageOf, runtimeLabel, sizeLabel } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CodeBlock } from '@/components/dashboard/code-block';
import { CopyButton } from '@/components/dashboard/copy-button';
import { StatePill } from '@/components/dashboard/status-pill';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const DEFAULT_IMAGE = 'ubuntu-24.04';

const CREATE_ERRORS: Record<string, string> = {
  capacity_exhausted: 'No host has room for that size right now. Try a smaller size or retry shortly.',
  connector_not_connected: 'A selected connector is no longer connected. Reconnect it on the Connectors page.',
  connector_admin_only: 'Only organization admins can create docks with connectors.',
  image_unknown: 'That image is not in the catalog. Pick another one.',
  image_unavailable: 'No host serves that image yet. Pick another one.',
};
const CPU_OPTIONS = [1, 2, 4, 8];
const MEMORY_OPTIONS_MIB = [1024, 2048, 4096, 8192, 16384];
/** Select sentinel: create omits environment so the org default applies. */
const DEFAULT_ENV = '__default';
const STATES = ['provisioning', 'provisioned', 'cloning', 'ready', 'idle', 'running', 'archiving', 'archived', 'error', 'unreachable'];

function DocksTable() {
  const router = useRouter();
  const params = useSearchParams();
  const { organizations, workspaces, selectedWorkspaceId } = useOrg();
  const [api] = useState(getDefaultApi);

  const query = params.get('q') ?? '';
  const stateFilter = params.get('state') ?? '';

  const [docks, setDocks] = useState<Dock[] | null>(null);
  const [runs, setRuns] = useState<GithubRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialogOpenState, setDialogOpenState] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Dock | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [formWorkspace, setFormWorkspace] = useState('');
  const [formName, setFormName] = useState('');
  const [formImage, setFormImage] = useState(DEFAULT_IMAGE);
  const [formCpus, setFormCpus] = useState(2);
  const [formMemoryMiB, setFormMemoryMiB] = useState(4096);
  // Kept as typed so the field can be cleared and retyped; parsed on create.
  const [formDisk, setFormDisk] = useState('20');
  const [createError, setCreateError] = useState<string | null>(null);
  const [formEnvironment, setFormEnvironment] = useState('');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [images, setImages] = useState<DockImage[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [formConnectors, setFormConnectors] = useState<string[]>([]);

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const s = next.toString();
      router.replace(`/docks${s ? `?${s}` : ''}`);
    },
    [params, router],
  );

  // Refresh only settles state from async continuations; the scope gates in
  // render cover the unloaded case, so no synchronous resets are needed.
  const refresh = useCallback(() => {
    api
      .listDocks(undefined, true)
      .then((rows) => {
        setDocks(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setDocks([]);
        setError(messageOf(e, 'Could not load docks.'));
      });
    if (!selectedWorkspaceId) return;
    api
      .listRuns(selectedWorkspaceId)
      .then((rows) => setRuns(rows))
      .catch(() => setRuns([]));
  }, [api, selectedWorkspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keeps the "for 3h 12m" durations moving without refetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The shell header "New dock" button and the command palette land here with
  // ?new=1; derive the open state so there is no effect-driven setState, and
  // drop the param on close so back/refresh does not reopen the dialog.
  const wantsNewFromUrl = params.get('new') === '1';
  const dialogOpen = dialogOpenState || wantsNewFromUrl;
  const closeDialog = useCallback(() => {
    setDialogOpenState(false);
    setCreateError(null);
    if (wantsNewFromUrl) setParam('new', '');
  }, [setParam, wantsNewFromUrl]);

  const diskParsed = Number(formDisk);
  const formDiskGiB = formDisk.trim() !== '' && Number.isInteger(diskParsed) && diskParsed >= 1 ? diskParsed : null;

  const workspaceForCreate = formWorkspace || selectedWorkspaceId || workspaces[0]?.id || '';
  const orgForCreate = workspaces.find((w) => w.id === workspaceForCreate)?.organizationId ?? '';

  // Environments belong to the workspace's organization; empty means its default.
  useEffect(() => {
    if (!dialogOpen || !orgForCreate) return;
    api
      .listEnvironments(orgForCreate)
      .then((rows) => setEnvironments(rows))
      .catch(() => setEnvironments([]));
  }, [api, dialogOpen, orgForCreate]);

  useEffect(() => {
    if (!dialogOpen) return;
    api
      .listImages()
      .then((rows) => setImages(rows))
      .catch(() => setImages([]));
  }, [api, dialogOpen]);

  useEffect(() => {
    if (!dialogOpen || !workspaceForCreate) return;
    api
      .listConnectors(workspaceForCreate)
      .then((rows) => setConnectors(rows.filter((c) => c.type === 'tool' && c.status === 'connected')))
      .catch(() => setConnectors([]));
  }, [api, dialogOpen, workspaceForCreate]);

  const orgRole = organizations.find((o) => o.id === orgForCreate)?.role;
  const isAdmin = orgRole === 'admin' || orgRole === 'owner';
  // Drop picks for connectors that are gone after a workspace switch.
  const pickedConnectors = formConnectors.filter((k) => connectors.some((c) => c.kind === k));

  const runByDock = useMemo(() => {
    const map = new Map<string, GithubRun>();
    for (const run of runs) {
      if (run.dockId && !map.has(run.dockId)) map.set(run.dockId, run);
    }
    return map;
  }, [runs]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (docks ?? []).filter(
      (d) =>
        (!stateFilter || d.state === stateFilter) &&
        (!q || d.name.toLowerCase().includes(q) || d.id.startsWith(q)),
    );
  }, [docks, query, stateFilter]);

  async function runAction(fn: () => Promise<unknown>, failure: string) {
    setActionError(null);
    try {
      await fn();
      refresh();
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
    }
  }

  async function create() {
    if (!workspaceForCreate) {
      setCreateError('Pick a workspace first.');
      return;
    }
    if (formDiskGiB === null) {
      setCreateError('Disk must be a whole number of GB, at least 1.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await api.createDock({
        workspaceId: workspaceForCreate,
        name: formName.trim() || undefined,
        image: formImage,
        cpus: formCpus,
        memoryMiB: formMemoryMiB,
        diskGiB: formDiskGiB,
        environment: formEnvironment || undefined,
        connectors: pickedConnectors.length ? pickedConnectors : undefined,
      });
      setFormName('');
      setFormConnectors([]);
      closeDialog();
      refresh();
    } catch (e: unknown) {
      const msg = CREATE_ERRORS[(e as { code?: string }).code ?? ''] ?? messageOf(e, 'request failed');
      setCreateError(`Could not create dock: ${msg}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Docks" description="Persistent docks. Stop one to pause compute, resume it with its disk intact, or branch it." />

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpenState(true) : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New dock</DialogTitle>
            <DialogDescription>Provisions a persistent dock in the selected workspace.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dock-workspace">Workspace</Label>
              <Select value={workspaceForCreate} onValueChange={(v) => setFormWorkspace(v ?? '')}>
                <SelectTrigger id="dock-workspace" className="w-full">
                  <SelectValue placeholder="Select workspace">
                    {(v: string) => workspaces.find((w) => w.id === v)?.name ?? 'Select workspace'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dock-env">Environment</Label>
              <Select
                value={formEnvironment || DEFAULT_ENV}
                onValueChange={(v) => setFormEnvironment(!v || v === DEFAULT_ENV ? '' : v)}
              >
                <SelectTrigger id="dock-env" className="w-full">
                  <SelectValue>
                    {(v: string) =>
                      v === DEFAULT_ENV ? `Default (${environments.find((e) => e.isDefault)?.name ?? 'base'})` : v
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_ENV}>Default ({environments.find((e) => e.isDefault)?.name ?? 'base'})</SelectItem>
                  {environments.map((e) => (
                    <SelectItem key={e.id} value={e.name}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dock-name">Name</Label>
              <Input
                id="dock-name"
                placeholder="generated if empty"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dock-image">Image</Label>
              <Select value={formImage} onValueChange={(v) => setFormImage(v ?? DEFAULT_IMAGE)}>
                <SelectTrigger id="dock-image" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(images.length ? images : [{ name: DEFAULT_IMAGE, description: '', available: true } as DockImage]).map((i) => (
                    <SelectItem key={i.name} value={i.name} disabled={!i.available}>
                      <span className="flex flex-col items-start">
                        <span>{i.name}</span>
                        {i.description || !i.available ? (
                          <span className="text-xs text-muted-foreground">
                            {i.available ? i.description : 'No host serves this image yet'}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dock-cpus">CPUs</Label>
              <Select value={String(formCpus)} onValueChange={(v) => setFormCpus(Number(v ?? 2))}>
                <SelectTrigger id="dock-cpus" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CPU_OPTIONS.map((c) => (
                    <SelectItem key={c} value={String(c)}>
                      {c} vCPU
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dock-memory">Memory</Label>
              <Select value={String(formMemoryMiB)} onValueChange={(v) => setFormMemoryMiB(Number(v ?? 4096))}>
                <SelectTrigger id="dock-memory" className="w-full">
                  <SelectValue>{(v: string) => `${Number(v) / 1024} GB`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_OPTIONS_MIB.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m / 1024} GB
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 flex flex-col gap-2">
              <Label>Connectors</Label>
              {!isAdmin ? (
                <p className="text-xs text-muted-foreground">Only organization admins can create docks with connectors.</p>
              ) : connectors.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No connected tools in this workspace.{' '}
                  <Link href="/connectors" className="text-foreground underline underline-offset-4">
                    Connect one
                  </Link>
                </p>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {connectors.map((c) => (
                    <Label key={c.kind} className="flex items-center gap-2 font-normal capitalize">
                      <Checkbox
                        checked={pickedConnectors.includes(c.kind)}
                        onCheckedChange={(on) =>
                          setFormConnectors(on ? [...pickedConnectors, c.kind] : pickedConnectors.filter((k) => k !== c.kind))
                        }
                      />
                      {c.kind}
                    </Label>
                  ))}
                </div>
              )}
            </div>
            <Collapsible className="col-span-2">
              <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
                More options
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 flex flex-col gap-2">
                <Label htmlFor="dock-disk">Disk (GB)</Label>
                <Input
                  id="dock-disk"
                  type="number"
                  min={1}
                  step={1}
                  value={formDisk}
                  aria-invalid={formDiskGiB === null}
                  onChange={(e) => setFormDisk(e.target.value)}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
          {createError ? <ErrorNote message={createError} /> : null}
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {sizeLabel({ cpus: formCpus, memoryMiB: formMemoryMiB, diskGiB: formDiskGiB })}
            </span>
            <Button type="button" disabled={creating || formDiskGiB === null} onClick={create}>
              {creating ? 'Creating…' : 'Create dock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search docks"
          placeholder="Search name or id"
          className="max-w-xs"
          defaultValue={query}
          onChange={(e) => setParam('q', e.target.value)}
        />
        <Select value={stateFilter || 'any'} onValueChange={(v) => setParam('state', !v || v === 'any' ? '' : v)}>
          <SelectTrigger aria-label="Filter by state" className="w-44">
            <SelectValue>{(v: string) => (v === 'any' ? 'Any state' : v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any state</SelectItem>
            {STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {actionError ? <ErrorNote message={actionError} /> : null}
      {error ? <ErrorNote message={error} onRetry={refresh} /> : null}
      {docks === null ? (
        <LoadingRows />
      ) : rows.length === 0 && docks.length > 0 ? (
        <EmptyNote title="No docks match." hint="Clear the search or state filter to see every dock." />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-md border border-dashed px-4 py-12 text-center">
          <div>
            <p className="text-sm font-medium">No docks yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create one here, or call the API with a key from Developers.
            </p>
          </div>
          <Button type="button" onClick={() => setDialogOpenState(true)}>
            <Plus />
            New dock
          </Button>
          <CodeBlock
            className="w-full max-w-xl text-left"
            lines={[
              `curl -X POST ${apiSnippetBase()}/v1/docks \\`,
              '  -H "Authorization: Bearer $DOCK_API_KEY" \\',
              '  -H "Content-Type: application/json" \\',
              `  -d '{"workspaceId":"${workspaceForCreate || '<workspace-id>'}"}'`,
            ]}
          />
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Spec</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last snapshot</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((dock) => {
                const run = runByDock.get(dock.id) ?? null;
                return (
                  <TableRow key={dock.id}>
                    <TableCell>
                      <Link href={`/docks/${dock.id}`} className="font-medium underline-offset-4 hover:underline">
                        {dock.name}
                      </Link>
                      <div className="flex items-center gap-0.5 text-muted-foreground">
                        <span className="font-mono text-xs">{dock.id.slice(0, 8)}</span>
                        <CopyButton value={dock.id} label="Copy dock ID" />
                        {run ? (
                          <Link href={`/runs/${run.id}`} className="ml-1 text-xs underline-offset-4 hover:underline">
                            run #{run.issueNumber}
                          </Link>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatePill state={dock.state} />
                      {dock.stateChangedAt ? (
                        <div className="mt-1 text-xs text-muted-foreground" title={formatDate(dock.stateChangedAt)}>
                          for {formatDuration(now - new Date(dock.stateChangedAt).getTime())}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {sizeLabel(dock)}
                      <div className="mt-1 text-xs text-muted-foreground">{runtimeLabel(dock.runtime)}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{dock.environment ?? '—'}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{dock.ip ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={dock.billingPausedAt ? 'outline' : 'secondary'}>
                        {dock.billingPausedAt ? 'Paused' : 'Metered'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" title={formatDate(dock.createdAt)}>
                      {formatAgo(dock.createdAt, now)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" title={formatDate(dock.lastSnapshotAt)}>
                      {formatAgo(dock.lastSnapshotAt, now)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${dock.name}`}
                            />
                          }
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem render={<Link href={`/docks/${dock.id}`} />}>Inspect</DropdownMenuItem>
                          {run ? (
                            <DropdownMenuItem
                              onClick={() => runAction(() => api.branchDock(dock.id), 'Could not branch dock')}
                            >
                              Branch
                            </DropdownMenuItem>
                          ) : (
                            <>
                              <DropdownMenuItem
                                onClick={() => runAction(() => api.resumeDock(dock.id), 'Could not resume dock')}
                              >
                                Resume
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => runAction(() => api.stopDock(dock.id), 'Could not stop dock')}
                              >
                                Stop
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => runAction(() => api.branchDock(dock.id), 'Could not branch dock')}
                              >
                                Branch
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuItem onClick={() => setDeleteTarget(dock)}>Delete…</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              Deleting is async and permanent. The dock and its snapshots are deleted; a dock whose snapshot backs a template cannot be deleted until that template is.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) runAction(() => api.deleteDock(target.id), 'Could not delete dock');
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

/** Docks ledger: one list query, filtered by name and state. */
export default function DocksPage() {
  return (
    <Suspense>
      <DocksTable />
    </Suspense>
  );
}
