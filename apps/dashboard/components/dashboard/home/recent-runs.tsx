import { useState } from 'react';
import Link from 'next/link';
import type { GithubRun } from '@/lib/dock-api';
import { formatAgo } from '@/lib/format';
import { recentItems } from '@/lib/home-summary';
import { LoadingRows } from '@/components/dashboard/data-states';
import { RUN_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
import type { Section } from './home';
import { HomeSection, ROW_GROUP, ROW_LINK } from './section';

export function RecentRuns({ runs }: { runs: Section<GithubRun[]> }) {
  const [now] = useState(() => Date.now());
  const rows = Array.isArray(runs) ? recentItems(runs) : [];
  return (
    <HomeSection
      title="Recent runs"
      hint="Issues handed to @dock."
      link={
        <Link href="/runs" className="text-sm text-muted-foreground hover:text-foreground">
          View all
        </Link>
      }
    >
      {runs === null ? (
        <LoadingRows rows={3} />
      ) : (
        <div className={ROW_GROUP}>
          {rows.map((r) => (
            <Link key={r.id} href={`/runs/${r.id}`} className={ROW_LINK}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {r.repo}#{r.issueNumber}
              </span>
              <StatePill state={r.state} toneMap={RUN_STATE_TONE} />
              <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
                {formatAgo(r.updatedAt ?? r.createdAt, now)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </HomeSection>
  );
}
