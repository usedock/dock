/** Small display helpers for dock tables. All values render in tabular contexts. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/** Coarse elapsed time: `45s`, `12m`, `3h 12m`, `2d 4h`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function formatAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return `${formatDuration(now - t)} ago`;
}

/** "2 vCPU · 4 GB memory · 20 GB disk" */
export function sizeLabel(d: { cpus?: number | null; memoryMiB?: number | null; diskGiB?: number | null }): string {
  // Docks created before sizes existed carry none of these fields.
  if (d.cpus == null || d.memoryMiB == null || d.diskGiB == null) return '—';
  return `${d.cpus} vCPU · ${d.memoryMiB / 1024} GB memory · ${d.diskGiB} GB disk`;
}

export function runtimeLabel(r: string | null | undefined): string {
  if (r === 'gvisor') return 'gVisor';
  if (r === 'microvm') return 'MicroVM';
  return '—';
}

export function messageOf(e: unknown, fallback: string): string {
  if ((e as { code?: unknown } | null)?.code === 'environment_secrets_admin_only') {
    return "This environment's secrets are limited to admins. Ask an organization admin to set its secrets access to Members, or choose another environment.";
  }
  return e instanceof Error ? e.message : fallback;
}
