'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getDefaultApi, type Environment } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** What docks boot with, one row per environment name. */
export default function EnvironmentsPage() {
  const { selectedOrgId } = useOrg();
  const [api] = useState(getDefaultApi);
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  // The scope gate in render covers the unselected case; no sync resets.
  const refresh = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .listEnvironments(selectedOrgId)
      .then((rows) => {
        setEnvs(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setEnvs([]);
        setError(messageOf(e, 'Could not load environments.'));
      });
  }, [api, selectedOrgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function create() {
    if (!selectedOrgId || !name.trim()) return;
    setCreating(true);
    setActionError(null);
    try {
      await api.createEnvironment(selectedOrgId, name.trim());
      setDialogOpen(false);
      setName('');
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not create environment: ${messageOf(e, 'request failed')}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Environments"
        description="Repositories, variables, and secret files that docks boot with. New docks use the default unless another is named."
        action={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button type="button" disabled={!selectedOrgId} />}>
              <Plus />
              New environment
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New environment</DialogTitle>
                <DialogDescription>Starts as an empty version 1. Lowercase letters, digits, dashes.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="env-name">Name</Label>
                <Input id="env-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="web" />
              </div>
              <DialogFooter>
                <Button type="button" disabled={creating || !name.trim()} onClick={create}>
                  {creating ? 'Creating…' : 'Create environment'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {actionError ? <ErrorNote message={actionError} /> : null}
      {!selectedOrgId ? (
        <EmptyNote title="Pick an organization." hint="Environments belong to an organization." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : envs === null ? (
        <LoadingRows />
      ) : envs.length === 0 ? (
        <EmptyNote title="No environments yet." hint="Create one to give docks repos and secrets." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Contents</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {envs.map((env) => (
                <TableRow key={env.name}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/environments/${encodeURIComponent(env.name)}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {env.name}
                      </Link>
                      {env.isDefault ? <Badge variant="secondary">default</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">v{env.currentVersion}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {env.repos.length} repos · {env.varNames.length} vars · {env.files.length} files
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(env.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
