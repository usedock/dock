'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { getDefaultApi } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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

const EVENT_TYPES = ['dock.ready', 'dock.error', 'dock.archived', 'dock.hydrated'];

interface Endpoint {
  id: string;
  name: string;
  url: string;
  events?: string[];
  secretPrefix?: string;
  disabled?: boolean;
  createdAt?: string;
}

interface Delivery {
  id?: string;
  event?: string;
  status?: number | null;
  error?: string | null;
  createdAt?: string;
}

/** Outbound dock lifecycle webhooks: endpoints plus delivery inspection. */
export default function WebhooksPage() {
  const { selectedOrgId } = useOrg();
  const [api] = useState(getDefaultApi);
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>([...EVENT_TYPES]);

  // The scope gate in render covers the unselected case; no sync resets.
  const refresh = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .listWebhookEndpoints(selectedOrgId)
      .then((rows) => {
        setEndpoints(rows as Endpoint[]);
        setError(null);
      })
      .catch((e: unknown) => {
        setEndpoints([]);
        setError(messageOf(e, 'Could not load webhook endpoints.'));
      });
  }, [api, selectedOrgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function toggleEvent(event: string) {
    setFormEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  async function create() {
    if (!selectedOrgId || !formName.trim() || !formUrl.trim() || formEvents.length === 0) return;
    setCreating(true);
    setActionError(null);
    setCreatedSecret(null);
    try {
      const created = (await api.createWebhookEndpoint({
        organizationId: selectedOrgId,
        name: formName.trim(),
        url: formUrl.trim(),
        events: formEvents,
      })) as { secret?: string };
      // Raw secret exists only here: show once, never store.
      setCreatedSecret(created.secret ?? null);
      setFormName('');
      setFormUrl('');
      setDialogOpen(false);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not create endpoint: ${messageOf(e, 'request failed')}`);
    } finally {
      setCreating(false);
    }
  }

  function showDeliveries(endpoint: Endpoint) {
    if (!selectedOrgId) return;
    if (openDeliveries === endpoint.id) {
      setOpenDeliveries(null);
      return;
    }
    setOpenDeliveries(endpoint.id);
    // Refetch on every open so new attempts show up; keep stale rows while loading.
    api
      .listWebhookDeliveries(endpoint.id, selectedOrgId)
      .then((rows) => setDeliveries((prev) => ({ ...prev, [endpoint.id]: rows as Delivery[] })))
      .catch(() => setDeliveries((prev) => ({ ...prev, [endpoint.id]: prev[endpoint.id] ?? [] })));
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Webhooks"
        description="Outbound dock lifecycle events. Writes need a browser session."
        action={
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) setCreatedSecret(null);
            }}
          >
            <DialogTrigger render={<Button type="button" disabled={!selectedOrgId} />}>
              <Plus />
              New endpoint
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New endpoint</DialogTitle>
                <DialogDescription>The signing secret is shown exactly once after creation.</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="wh-name">Name</Label>
                  <Input id="wh-name" value={formName} onChange={(e) => setFormName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="wh-url">URL</Label>
                  <Input
                    id="wh-url"
                    inputMode="url"
                    placeholder="https://example.com/hooks/dock"
                    value={formUrl}
                    onChange={(e) => setFormUrl(e.target.value)}
                  />
                </div>
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium">Events</legend>
                  {EVENT_TYPES.map((event) => (
                    <label key={event} className="flex items-center gap-2 font-mono text-sm">
                      <Checkbox checked={formEvents.includes(event)} onCheckedChange={() => toggleEvent(event)} />
                      {event}
                    </label>
                  ))}
                </fieldset>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  disabled={creating || !formName.trim() || !formUrl.trim() || formEvents.length === 0}
                  onClick={create}
                >
                  {creating ? 'Creating…' : 'Create endpoint'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {actionError ? <ErrorNote message={actionError} /> : null}
      {createdSecret ? (
        <div role="alert" className="rounded-md border px-4 py-3 text-sm">
          <p className="font-medium">Signing secret (shown once — copy it now):</p>
          <div className="mt-1 flex items-center gap-1">
            <p className="font-mono text-xs break-all">{createdSecret}</p>
            <CopyButton value={createdSecret} label="Copy signing secret" />
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setCreatedSecret(null)}>
            Dismiss (clears the secret)
          </Button>
        </div>
      ) : null}
      {!selectedOrgId ? (
        <EmptyNote title="Pick an organization." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : endpoints === null ? (
        <LoadingRows />
      ) : endpoints.length === 0 ? (
        <EmptyNote title="No endpoints." hint="Create one to receive dock lifecycle events." />
      ) : (
        <div className="flex flex-col gap-3">
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} className="rounded-md border">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex-1">
                  <p className="font-medium">{endpoint.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{endpoint.url}</p>
                </div>
                {endpoint.disabled ? <Badge variant="outline">disabled</Badge> : null}
                <Button type="button" variant="outline" size="sm" onClick={() => showDeliveries(endpoint)}>
                  {openDeliveries === endpoint.id ? 'Hide deliveries' : 'Deliveries'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!selectedOrgId) return;
                    api
                      .removeWebhookEndpoint(endpoint.id, selectedOrgId)
                      .then(() => refresh())
                      .catch((e: unknown) =>
                        setActionError(`Could not delete endpoint: ${messageOf(e, 'request failed')}`),
                      );
                  }}
                >
                  Delete
                </Button>
              </div>
              {openDeliveries === endpoint.id ? (
                <div className="border-t px-4 py-3">
                  {(deliveries[endpoint.id] ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No deliveries yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Event</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>At</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(deliveries[endpoint.id] ?? []).map((d, i) => (
                          <TableRow key={d.id ?? i}>
                            <TableCell className="font-mono text-xs">{d.event ?? '—'}</TableCell>
                            <TableCell>
                              {d.error ? (
                                <Badge variant="destructive" title={d.error} className="max-w-[16rem] truncate">
                                  {d.error}
                                </Badge>
                              ) : (
                                <Badge variant="secondary">{d.status ?? '—'}</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{formatDate(d.createdAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
