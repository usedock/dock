import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { GithubRun } from '@/lib/dock-api';
import { formatAgo } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { recentItems, type Section } from '@/lib/home-summary';
import { LoadingRows } from '@/components/dashboard/data-states';
import { RUN_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
import { Button } from '@/components/ui/button';
import { HomeSection, ROW_GROUP, ROW_LINK } from './section';

export function RecentRuns({ runs }: { runs: Section<GithubRun[]> }) {
  const now = useNow();
  const rows = Array.isArray(runs) ? recentItems(runs) : [];
  return (
    <HomeSection
      title="Recent runs"
      hint="Issues handed to @dock."
      link={
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/runs" />}>
          View all runs
          <ArrowRight />
        </Button>
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
