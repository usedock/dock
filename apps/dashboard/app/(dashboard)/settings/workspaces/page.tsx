'use client';

import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { getDefaultApi, type Workspace } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows } from '@/components/dashboard/data-states';
import { SettingsSection } from '@/components/dashboard/settings-section';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** Workspaces in the selected organization. Every dock lives in exactly one; the last one stays. */
export default function WorkspacesPage() {
  const { selectedOrgId, workspaces, selectedWorkspaceId, selectWorkspace, reloadWorkspaces, loading } = useOrg();
  const [api] = useState(getDefaultApi);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);

  async function runAction(fn: () => Promise<unknown>, failure: string): Promise<boolean> {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      reloadWorkspaces();
      return true;
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!selectedOrgId || !name.trim()) return;
    if (await runAction(() => api.createWorkspace(selectedOrgId, { name: name.trim() }), 'Could not create workspace')) {
      setName('');
    }
  }

  if (!selectedOrgId) return <EmptyNote title="Pick an organization." />;

  return (
    <>
      {actionError ? <ErrorNote message={actionError} /> : null}

      <SettingsSection
        title="Create a workspace"
        description="Workspaces group docks, environments, and @dock runs inside the organization."
        footer={
          <Button type="submit" form="create-workspace" size="sm" disabled={!name.trim() || busy}>
            Create workspace
          </Button>
        }
      >
        <form
          id="create-workspace"
          className="flex max-w-sm flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Label htmlFor="workspace-name">Name</Label>
          <Input id="workspace-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="staging" />
        </form>
      </SettingsSection>

      <SettingsSection
        title="Workspaces"
        description="Every dock lives in exactly one workspace. The organization keeps at least one."
        flush
      >
        {loading ? (
          <div className="p-5">
            <LoadingRows rows={3} />
          </div>
        ) : workspaces.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No workspaces yet.</p>
        ) : (
          <ul className="divide-y">
            {workspaces.map((ws) => {
              const current = ws.id === selectedWorkspaceId;
              return (
                <li key={ws.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {ws.name}
                      {current ? <Badge variant="secondary">Current</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono">{ws.slug ?? ws.id.slice(0, 8)}</span> · created {formatDate(ws.createdAt)}
                    </span>
                  </div>
                  {!current ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => selectWorkspace(ws.id)}>
                      Switch
                    </Button>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${ws.name}`} />}
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenameTarget(ws);
                          setRenameValue(ws.name);
                        }}
                      >
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={workspaces.length <= 1}
                        onClick={() => setDeleteTarget(ws)}
                      >
                        {workspaces.length <= 1 ? 'Delete (keep at least one)' : 'Delete'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const target = renameTarget;
              if (!target || !renameValue.trim()) return;
              if (await runAction(() => api.updateWorkspace(target.id, { name: renameValue.trim() }), 'Could not rename workspace')) {
                setRenameTarget(null);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename workspace</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-rename">Name</Label>
              <Input
                id="workspace-rename"
                value={renameValue}
                maxLength={100}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!renameValue.trim() || busy}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>The workspace must have no docks left. Runs recorded in it are deleted with it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) void runAction(() => api.deleteWorkspace(target.id), 'Could not delete workspace');
              }}
            >
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
