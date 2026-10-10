'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getDefaultApi, type HostSummary } from '@/lib/dock-api';
import { formatAgo, formatBytes, formatDate, messageOf, runtimeLabel } from '@/lib/format';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
import { HOST_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Instance-admin view of the hosts behind every dock. */
export default function HostsPage() {
  const [api] = useState(getDefaultApi);
  const [hosts, setHosts] = useState<HostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    api
      .listHosts()
      .then((rows) => {
        setHosts(rows);
        setError(null);
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        setHosts([]);
        setError(messageOf(e, 'Could not load hosts.'));
      });
  }, [api]);

  // Hosts heartbeat every 30s, so poll at the same pace.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Hosts" description="Machines enrolled in this instance. Docks are placed on online hosts." />

      {error ? <ErrorNote message={error} onRetry={refresh} /> : null}
      {hosts === null ? (
        <LoadingRows />
      ) : hosts.length === 0 ? (
        error ? null : (
          <EmptyNote
            title="No hosts enrolled."
            hint="Run bootstrap-host.sh on a machine; it appears here after its first heartbeat."
          />
        )
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Host</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead>Docks</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Enrolled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hosts.map((host) => (
                <TableRow key={host.id}>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <Link href={`/hosts/${host.id}`} className="font-mono text-sm underline-offset-4 hover:underline">
                        {host.id}
                      </Link>
                      <CopyButton value={host.id} label="Copy host ID" />
                    </div>
                    <div className="text-xs text-muted-foreground">{host.cpuFamily}</div>
                  </TableCell>
                  <TableCell>
                    <StatePill state={host.state} toneMap={HOST_STATE_TONE} />
                    <div className="mt-1 text-xs text-muted-foreground" title={formatDate(host.lastHeartbeatAt)}>
                      {host.lastHeartbeatAt ? `seen ${formatAgo(host.lastHeartbeatAt, now)}` : 'never seen'}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {runtimeLabel(host.runtime)}
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {host.kernelRelease ?? host.kernel}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {host.runningDocks} / {host.maxDocks}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {host.vcpuTotal} vCPU · {formatBytes(host.memTotalBytes)}
                    <div className="mt-1 text-xs text-muted-foreground">{formatBytes(host.diskTotalBytes)} disk</div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground" title={formatDate(host.createdAt)}>
                    {formatAgo(host.createdAt, now)}
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
