'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getDefaultApi, type Dock, type GithubRun } from '@/lib/dock-api';
import { dockStateLabel } from '@/lib/dock-state';
import { formatDate, messageOf } from '@/lib/format';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { CopyButton } from '@/components/dashboard/copy-button';
import { RUN_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
const TERMINAL_RUN: Record<string, true> = { done: true, failed: true, stopped: true };
const RUNNABLE_DOCK: Record<string, true> = {
  provisioning: true,
  provisioned: true,
  cloning: true,
  ready: true,
  idle: true,
  running: true,
};

/** Single run: timeline, evidence, and links that survive completion. */
export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [api] = useState(getDefaultApi);
  const [run, setRun] = useState<GithubRun | null>(null);
  const [dock, setDock] = useState<Dock | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Error clears in the success continuation; no synchronous reset needed.
  useEffect(() => {
    let cancelled = false;
    api
      .getRun(id)
      .then((r) => {
        if (cancelled) return;
        setRun(r);
        setError(null);
        if (r.dockId) {
          api
            .getDock(r.dockId)
            .then((d) => !cancelled && setDock(d))
            .catch(() => !cancelled && setDock(null));
        }
      })
      .catch((e: unknown) => !cancelled && setError(messageOf(e, 'Could not load run.')));
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Run" />
        <ErrorNote message={error} />
      </div>
    );
  }
  if (!run) return <LoadingRows />;

  const orphan = dock !== null && TERMINAL_RUN[run.state] && RUNNABLE_DOCK[dock.state];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${run.repo}#${run.issueNumber}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
            Run <span className="font-mono break-all">{run.id}</span>
            <CopyButton value={run.id} label="Copy run ID" />
          </span>
        }
        action={<StatePill state={run.state} toneMap={RUN_STATE_TONE} />}
      />

      {run.failureReason ? (
        <ErrorNote message={`Failed: ${run.failureReason}${run.completionStatus ? ` (reported ${run.completionStatus})` : ''}`} />
      ) : null}
      {orphan && dock ? (
        <ErrorNote
          message={`Run is ${run.state} but dock ${dock.name} is still ${dock.state} and metering. Stop it from the dock page if the work is done.`}
        />
      ) : null}

      <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Issue</dt>
          <dd className="text-sm font-medium">
            {run.repo}#{run.issueNumber}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Dock</dt>
          <dd className="font-mono text-sm">
            {run.dockId ? (
              <Link href={`/docks/${run.dockId}`} className="underline underline-offset-4">
                {dock?.name ?? run.dockId.slice(0, 8)}
              </Link>
            ) : (
              '—'
            )}
            {dock ? <span className="text-muted-foreground"> · {dockStateLabel(dock.state)}</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Pull request</dt>
          <dd className="text-sm">
            {run.prNumber ? (
              <a
                href={run.prUrl ?? undefined}
                target={run.prUrl ? '_blank' : undefined}
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                PR #{run.prNumber}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Branch</dt>
          <dd className="font-mono text-sm">{run.branch ?? '—'}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Agent</dt>
          <dd className="font-mono text-sm">
            {run.agent ?? '—'}
            {run.promptVersion ? <span className="text-muted-foreground"> · {run.promptVersion}</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">Test evidence</dt>
          <dd className="font-mono text-sm">
            {run.testCommand ?? 'no test command'}
            {run.completionStatus ? <span className="text-muted-foreground"> · {run.completionStatus}</span> : null}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Timeline</h2>
        {run.events && run.events.length > 0 ? (
          <ol className="flex flex-col rounded-md border">
            {run.events.map((event, i) => (
              <li key={`${event.t}-${i}`} className="flex gap-3 border-b px-4 py-2 font-mono text-xs last:border-b-0">
                <span className="text-muted-foreground">{formatDate(event.at)}</span>
                <span>{event.t}</span>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyNote title="No events yet." />
        )}
      </div>
    </div>
  );
}
