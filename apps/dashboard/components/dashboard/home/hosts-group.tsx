import Link from 'next/link';
import type { HostSummary } from '@/lib/dock-api';
import { HOST_STATE_TONE, StatePill } from '@/components/dashboard/status-pill';
import { HomeSection, ROW_GROUP, ROW_LINK } from './section';

export function HostsGroup({ hosts }: { hosts: HostSummary[] }) {
  const online = hosts.filter((h) => h.state === 'online').length;
  return (
    <HomeSection title="Hosts" hint="Machines that run your docks.">
      <div className={ROW_GROUP}>
        <Link href="/hosts" className={ROW_LINK}>
          <span className="flex-1">
            <span className="font-mono tabular-nums">
              {online}/{hosts.length}
            </span>{' '}
            online
          </span>
          <StatePill state={online > 0 ? 'online' : 'offline'} toneMap={HOST_STATE_TONE} />
        </Link>
      </div>
    </HomeSection>
  );
}
