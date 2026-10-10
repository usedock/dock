'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { getDefaultApi, type SshKey } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { CodeBlock } from '@/components/dashboard/code-block';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
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
import { Textarea } from '@/components/ui/textarea';

/** SSH public keys that may open shells on any dock the user can reach. */
export default function SshKeysPage() {
  const [api] = useState(getDefaultApi);
  const instance = useInstanceConfig();
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');

  const refresh = useCallback(() => {
    api
      .listSshKeys()
      .then((rows) => {
        setKeys(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setKeys([]);
        setError(messageOf(e, 'Could not load SSH keys.'));
      });
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function add() {
    if (!name.trim() || !publicKey.trim()) return;
    setAdding(true);
    setActionError(null);
    try {
      await api.addSshKey(name.trim(), publicKey.trim());
      setName('');
      setPublicKey('');
      setDialogOpen(false);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not add key: ${messageOf(e, 'request failed')}`);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="SSH keys"
        description="Public keys that can open a shell on any dock you can reach. At most 20 keys."
        action={
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) {
                setName('');
                setPublicKey('');
              }
            }}
          >
            <DialogTrigger render={<Button type="button" />}>
              <Plus />
              Add key
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add SSH key</DialogTitle>
                <DialogDescription>Paste a public key, such as the contents of ~/.ssh/id_ed25519.pub.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ssh-key-name">Name</Label>
                <Input id="ssh-key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ssh-key-value">Public key</Label>
                <Textarea
                  id="ssh-key-value"
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder="ssh-ed25519 AAAA… you@laptop"
                  className="min-h-24 font-mono break-all"
                  spellCheck={false}
                />
              </div>
              {actionError ? <ErrorNote message={actionError} /> : null}
              <DialogFooter>
                <Button type="button" disabled={adding || !name.trim() || !publicKey.trim()} onClick={add}>
                  {adding ? 'Adding…' : 'Add key'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {instance && !instance.ssh ? (
        <EmptyNote title="SSH is turned off on this instance." hint="Keys you add here work once an operator sets SSH_GATEWAY_PORT on the API." />
      ) : null}
      {actionError && !dialogOpen ? <ErrorNote message={actionError} /> : null}
      {error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : keys === null ? (
        <LoadingRows />
      ) : keys.length === 0 ? (
        <div className="flex flex-col gap-3">
          <EmptyNote title="No SSH keys." hint="Add a public key to connect to your docks with ssh. No key yet? Create one:" />
          <CodeBlock lines={['ssh-keygen -t ed25519', 'cat ~/.ssh/id_ed25519.pub']} />
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs">{key.fingerprint}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(key.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        api
                          .deleteSshKey(key.id)
                          .then(() => refresh())
                          .catch((e: unknown) => setActionError(`Could not delete key: ${messageOf(e, 'request failed')}`))
                      }
                    >
                      Delete
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
