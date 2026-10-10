'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { getDefaultApi } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
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

interface ApiKeyMeta {
  id: string;
  name: string;
  keyPrefix?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
}

/** Self-service API keys. Raw secrets appear only in the create response. */
export default function ApiKeysPage() {
  const [api] = useState(getDefaultApi);
  const [keys, setKeys] = useState<ApiKeyMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ id: string; apiKey: string } | null>(null);

  // Settles state only from async continuations; render starts unloaded.
  const refresh = useCallback(() => {
    api
      .listApiKeys()
      .then((rows) => {
        setKeys(rows as ApiKeyMeta[]);
        setError(null);
      })
      .catch((e: unknown) => {
        setKeys([]);
        setError(messageOf(e, 'Could not load API keys.'));
      });
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setActionError(null);
    setCreated(null);
    try {
      const row = await api.createApiKey(name.trim());
      // Raw secret exists only here: show once, never store.
      setCreated(row);
      setName('');
      setDialogOpen(false);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not create key: ${messageOf(e, 'request failed')}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="API keys"
        description="Service keys for automation. At most 20 active keys."
        action={
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) setName('');
            }}
          >
            <DialogTrigger render={<Button type="button" />}>
              <Plus />
              New key
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
                <DialogDescription>The raw secret is shown exactly once after creation.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-name">Name</Label>
                <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ci" />
              </div>
              <DialogFooter>
                <Button type="button" disabled={creating || !name.trim()} onClick={create}>
                  {creating ? 'Creating…' : 'Create key'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {actionError ? <ErrorNote message={actionError} /> : null}
      {created ? (
        <div role="alert" className="rounded-md border px-4 py-3 text-sm">
          <p className="font-medium">Raw secret (shown once — copy it now):</p>
          <div className="mt-1 flex items-center gap-1">
            <p className="font-mono text-xs break-all">{created.apiKey}</p>
            <CopyButton value={created.apiKey} label="Copy API key" />
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setCreated(null)}>
            Dismiss (clears the secret)
          </Button>
        </div>
      ) : null}
      {error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : keys === null ? (
        <LoadingRows />
      ) : keys.length === 0 ? (
        <EmptyNote title="No API keys." hint="Create one for CI or scripting. Service keys cannot move money or close accounts." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs">{key.keyPrefix ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(key.expiresAt)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(key.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        api
                          .revokeApiKey(key.id)
                          .then(() => refresh())
                          .catch((e: unknown) =>
                            setActionError(`Could not revoke key: ${messageOf(e, 'request failed')}`),
                          )
                      }
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
