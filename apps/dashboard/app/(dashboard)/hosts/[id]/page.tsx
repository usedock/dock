'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getDefaultApi, type HostDetail, type HostWorkload } from '@/lib/dock-api';
import { formatAgo, formatBytes, formatDate, formatDuration, messageOf, runtimeLabel, sizeLabel } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
import { HOST_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function Detail({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-sm ${mono ? 'font-mono' : ''}`} title={title}>
        {value}
      </dd>
    </div>
  );
}

function WorkloadTable({ rows }: { rows: HostWorkload[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Runtime</TableHead>
            <TableHead>Reported state</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((w) => (
            <TableRow key={w.dockId}>
              <TableCell>
                <div className="flex items-center gap-0.5">
                  <span className="font-mono text-xs">{w.dockId}</span>
                  <CopyButton value={w.dockId} label="Copy runtime ID" />
                </div>
              </TableCell>
              <TableCell className="text-sm">{w.state}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One host: capacity, heartbeat, and everything placed on it across organizations. */
export default function HostDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { organizations } = useOrg();
  const [api] = useState(getDefaultApi);
  const [host, setHost] = useState<HostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    api
      .getHost(id)
      .then((row) => {
        setHost(row);
        setError(null);
        setNow(Date.now());
      })
      .catch((e: unknown) => setError(messageOf(e, 'Could not load host.')));
  }, [api, id]);

  // Hosts heartbeat every 30s, so poll at the same pace.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error && !host) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Host" />
        <ErrorNote message={error} onRetry={refresh} />
      </div>
    );
  }
  if (!host) return <LoadingRows />;

  const memberOf = new Set(organizations.map((o) => o.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={host.id}
        description={
          <>
            <Link href="/hosts" className="underline-offset-4 hover:underline">
              Hosts
            </Link>{' '}
            · {runtimeLabel(host.runtime)} on {host.cpuFamily}
          </>
        }
        action={<StatePill state={host.state} toneMap={HOST_STATE_TONE} />}
      />
      {error ? <ErrorNote message={error} onRetry={refresh} /> : null}

      <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-4">
        <Detail
          label="Last heartbeat"
          value={host.lastHeartbeatAt ? formatAgo(host.lastHeartbeatAt, now) : 'never'}
          title={formatDate(host.lastHeartbeatAt)}
        />
        <Detail label="Docks" value={`${host.runningDocks} running / ${host.maxDocks} max`} />
        <Detail label="vCPU" value={String(host.vcpuTotal)} />
        <Detail label="Memory" value={formatBytes(host.memTotalBytes)} />
        <Detail label="Disk" value={formatBytes(host.diskTotalBytes)} />
        <Detail label="Runtime" value={runtimeLabel(host.runtime)} />
        <Detail label="Kernel" value={host.kernelRelease ?? host.kernel} mono />
        <Detail label="CPU family" value={host.cpuFamily} mono />
        <Detail label="Connects from" value={host.address} mono />
        <Detail label="Enrolled" value={formatAgo(host.createdAt, now)} title={formatDate(host.createdAt)} />
      </dl>

      <section className="flex flex-col gap-2" aria-labelledby="host-docks">
        <h2 id="host-docks" className="text-sm font-medium">
          Docks on this host
        </h2>
        {host.docks.length === 0 ? (
          <EmptyNote title="No docks placed here." />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Spec</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {host.docks.map((dock) => (
                  <TableRow key={dock.id}>
                    <TableCell>
                      {memberOf.has(dock.organizationId) ? (
                        <Link href={`/docks/${dock.id}`} className="font-medium underline-offset-4 hover:underline">
                          {dock.name}
                        </Link>
                      ) : (
                        <span className="font-medium">{dock.name}</span>
                      )}
                      <div className="flex items-center gap-0.5 text-muted-foreground">
                        <span className="font-mono text-xs">{dock.id.slice(0, 8)}</span>
                        <CopyButton value={dock.id} label="Copy dock ID" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatePill state={dock.state} />
                      <div className="mt-1 text-xs text-muted-foreground" title={formatDate(dock.stateChangedAt)}>
                        for {formatDuration(now - new Date(dock.stateChangedAt).getTime())}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {sizeLabel(dock)} · {runtimeLabel(dock.runtime)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{dock.ip ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      {dock.organizationName}
                      <div className="mt-1 text-xs text-muted-foreground">{dock.workspaceName}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {host.runs.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="host-runs">
          <h2 id="host-runs" className="text-sm font-medium">
            Agent runs
          </h2>
          <WorkloadTable rows={host.runs} />
        </section>
      ) : null}

      {host.orphans.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="host-orphans">
          <h2 id="host-orphans" className="text-sm font-medium">
            Untracked runtimes
          </h2>
          <p className="text-sm text-muted-foreground">
            The host reports these but no dock record claims them. The reconciler destroys them on its next pass.
          </p>
          <WorkloadTable rows={host.orphans} />
        </section>
      ) : null}
    </div>
  );
}
