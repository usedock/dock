import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Dock } from '@/lib/dock-api';
import { formatAgo } from '@/lib/format';
import { recentItems } from '@/lib/home-summary';
import { EmptyNote, LoadingRows } from '@/components/dashboard/data-states';
import { StatePill } from '@/components/dashboard/status-pill';
import { Button } from '@/components/ui/button';
import type { Section } from './home';
import { HomeSection, ROW_GROUP, ROW_LINK } from './section';

export function RecentDocks({ docks }: { docks: Section<Dock[]> }) {
  const [now] = useState(() => Date.now());
  const rows = Array.isArray(docks) ? recentItems(docks) : [];
  return (
    <HomeSection
      title="Recent docks"
      hint="The docks that changed most recently."
      link={
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/docks" />}>
          View all docks
          <ArrowRight />
        </Button>
      }
    >
      {docks === null ? (
        <LoadingRows rows={3} />
      ) : docks === 'error' ? (
        <EmptyNote title="Could not load docks." hint="Open the Docks page to retry." />
      ) : rows.length === 0 ? (
        <EmptyNote
          title="No docks yet."
          hint={
            <Link href="/docks?new=1" className="text-foreground underline underline-offset-4">
              Create your first dock
            </Link>
          }
        />
      ) : (
        <div className={ROW_GROUP}>
          {rows.map((d) => (
            <Link key={d.id} href={`/docks/${d.id}`} className={ROW_LINK}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{d.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  <span className="font-mono">{d.id}</span>
                  {d.image ? ` · ${d.image}` : ''}
                </span>
              </span>
              <StatePill state={d.state} />
              <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:block">
                {formatAgo(d.stateChangedAt ?? d.updatedAt ?? d.createdAt, now)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </HomeSection>
  );
}
