'use client';

import { useEffect, useState } from 'react';
import type { DockApi, DockStats as DockStatsData, DockStatsMetrics } from '@/lib/dock-api';
import { formatBytes, formatDate } from '@/lib/format';
import { EmptyNote } from '@/components/dashboard/data-states';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

// Matches the docklet's sampling cadence, so every poll can bring a new sample.
const POLL_MS = 15_000;

function percent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function memShare(m: DockStatsMetrics): number | null {
  return m.memLimit > 0 ? Math.min(100, (m.memBytes / m.memLimit) * 100) : null;
}

function Tile({
  label,
  value,
  detail,
  meter,
  footer,
}: {
  label: string;
  value: string;
  detail?: string;
  meter?: number | null;
  footer: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {meter === undefined ? null : meter === null ? (
        <span className="h-1" />
      ) : (
        <Progress value={meter} aria-label={`${label} usage`} className="[&_[data-slot=progress-track]]:bg-primary/15" />
      )}
      <span className="text-xs text-muted-foreground">{footer}</span>
    </div>
  );
}

/** Usage tiles for one dock: current sample plus the window's average and peak, polled live. */
export function DockStats({ api, dockId, window }: { api: DockApi; dockId: string; window: '1h' | '24h' }) {
  const [stats, setStats] = useState<{ window: string; data: DockStatsData | null } | null>(null);

  // Stats render only when the loaded window matches, so a window switch
  // shows loading instead of stale numbers.
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .dockStats(dockId, window)
        .then((data) => live && setStats({ window, data }))
        .catch(() => live && setStats({ window, data: null }));
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, dockId, window]);

  if (stats === null || stats.window !== window) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Loading">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    );
  }
  const sample = stats.data?.sample;
  if (!sample) {
    return <EmptyNote title="No usage samples yet." hint="The host samples CPU, memory, network, and disk I/O every 15 seconds while the dock runs." />;
  }

  const agg = stats.data?.window;
  const hasWindow = agg !== undefined && agg.samples > 0;
  const span = `Last ${window}`;
  const memFooter = hasWindow
    ? `${span} avg ${formatBytes(agg.avg.memBytes)} · peak ${formatBytes(agg.peak.memBytes)}`
    : 'No history for this window yet';

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="CPU"
          value={percent(sample.cpuPercent)}
          detail="of allotted vCPUs"
          meter={sample.cpuPercent}
          footer={hasWindow ? `${span} avg ${percent(agg.avg.cpuPercent)} · peak ${percent(agg.peak.cpuPercent)}` : 'No history for this window yet'}
        />
        <Tile
          label="Memory"
          value={formatBytes(sample.memBytes)}
          detail={sample.memLimit > 0 ? `of ${formatBytes(sample.memLimit)}` : 'no limit'}
          meter={memShare(sample)}
          footer={memFooter}
        />
        <Tile label="Network" value={formatBytes(sample.rxBytes)} detail={`in · ${formatBytes(sample.txBytes)} out`} footer="Total since the dock started" />
        <Tile label="Disk I/O" value={formatBytes(sample.diskBytes)} detail="read + written" footer="Total since the dock started" />
      </div>
      <p className="text-xs text-muted-foreground">
        Measured on the host · last sample {formatDate(sample.at)}
        {hasWindow ? ` · ${agg.samples} samples in the last ${window}` : ''}
      </p>
    </div>
  );
}
