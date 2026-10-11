'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import type { DockApi, DockPort } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useInstanceConfigState } from '@/lib/use-instance-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CopyButton } from './copy-button';
import { EmptyNote, ErrorNote, LoadingRows } from './data-states';

const MAX_PORTS = 10;

/** Ports of one dock served at URLs through the instance's ports domain; private unless made public. */
export function DockPorts({ api, dockId, running }: { api: DockApi; dockId: string; running: boolean }) {
  const { config: instance, failed: instanceFailed } = useInstanceConfigState();
  const [ports, setPorts] = useState<DockPort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api
      .listDockPorts(dockId)
      .then((rows) => {
        setPorts(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setPorts([]);
        setError(messageOf(e, 'Could not load ports.'));
      });
  }, [api, dockId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const port = Number(value);
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;

  async function expose(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.exposeDockPort(dockId, port, isPublic ? 'public' : 'private');
      setValue('');
      refresh();
    } catch (err: unknown) {
      setActionError(`Could not expose port ${port}: ${messageOf(err, 'request failed')}`);
    } finally {
      setBusy(false);
    }
  }

  function setVisibility(target: number, makePublic: boolean) {
    setActionError(null);
    api
      .exposeDockPort(dockId, target, makePublic ? 'public' : 'private')
      .then(() => refresh())
      .catch((err: unknown) => setActionError(`Could not change port ${target}: ${messageOf(err, 'request failed')}`));
  }

  function remove(target: number) {
    setActionError(null);
    api
      .removeDockPort(dockId, target)
      .then(() => refresh())
      .catch((err: unknown) => setActionError(`Could not remove port ${target}: ${messageOf(err, 'request failed')}`));
  }

  if (instanceFailed) return <ErrorNote message="Could not load instance settings. Reload the page to retry." />;
  if (!instance) return <LoadingRows rows={2} />;
  if (!instance.ports) {
    return (
      <EmptyNote
        title="Hosted ports are turned off on this instance."
        hint="An operator enables them by setting PORTS_DOMAIN and PORTS_PROXY_PORT on the API. Reach services inside the dock with the exec API in the meantime."
      />
    );
  }

  return (
    <>
      <form onSubmit={expose} className="flex flex-col gap-2">
        <Label htmlFor="dock-port">Expose a port</Label>
        <div className="flex gap-2">
          <Input
            id="dock-port"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value.trim())}
            placeholder="3000"
            className="w-32 font-mono"
          />
          <Button type="submit" disabled={busy || !valid || (ports?.length ?? 0) >= MAX_PORTS}>
            {busy ? 'Exposing…' : 'Expose'}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="dock-port-public" checked={isPublic} onCheckedChange={setIsPublic} />
          <Label htmlFor="dock-port-public">Anyone with the URL can open it</Label>
        </div>
        <p className="text-sm text-muted-foreground">
          Serves a port inside the dock at an HTTPS URL, including services bound to localhost. A private port opens for
          members of this organization after they sign in; make it public for callers that cannot sign in, such as webhooks.
          At most {MAX_PORTS} ports per dock.
        </p>
      </form>
      {!running ? <EmptyNote title="Port URLs answer only while the dock is running." hint="Resume the dock to reach its ports." /> : null}
      {actionError ? <ErrorNote message={actionError} /> : null}
      {error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : ports === null ? (
        <LoadingRows rows={2} />
      ) : ports.length === 0 ? (
        <EmptyNote title="No ports exposed." hint="Start a server in the dock, then expose its port here." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Port</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Public</TableHead>
                <TableHead>Exposed</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ports.map((row) => (
                <TableRow key={row.port}>
                  <TableCell className="font-mono text-sm">{row.port}</TableCell>
                  <TableCell>
                    {row.url ? (
                      <span className="flex items-center gap-0.5">
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline"
                        >
                          {row.url}
                          <ExternalLink className="size-3" />
                        </a>
                        <CopyButton value={row.url} label={`Copy URL for port ${row.port}`} />
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`Anyone with the URL can open port ${row.port}`}
                      checked={row.visibility === 'public'}
                      onCheckedChange={(checked) => setVisibility(row.port, checked)}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(row.port)}>
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
