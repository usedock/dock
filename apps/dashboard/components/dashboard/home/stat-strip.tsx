import type { Dock } from '@/lib/dock-api';
import { formatMemoryInUse, summarizeDocks } from '@/lib/home-summary';
import type { Section } from './home';

function Cell({ label, value, live = false }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {live ? <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> : null}
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function StatStrip({ docks }: { docks: Section<Dock[]> }) {
  const known = Array.isArray(docks);
  const s = summarizeDocks(known ? docks : []);
  const show = (v: string) => (known ? v : '—');
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
      <Cell label="Running docks" value={show(String(s.running))} live={known && s.running > 0} />
      <Cell label="Stopped docks" value={show(String(s.stopped))} />
      <Cell label="vCPUs in use" value={show(String(s.vcpusInUse))} />
      <Cell label="Memory in use" value={show(formatMemoryInUse(s.memoryMiBInUse))} />
    </div>
  );
}
