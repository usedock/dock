import type { Dock } from './dock-api';

// Live tone states in status-pill: the dock holds its vCPUs and memory.
const RUNNING = ['running', 'ready'];
const STOPPED = ['archived', 'archiving'];

export interface DockSummary {
  running: number;
  stopped: number;
  vcpusInUse: number;
  memoryMiBInUse: number;
}

export function summarizeDocks(docks: Dock[]): DockSummary {
  const live = docks.filter((d) => RUNNING.includes(d.state));
  return {
    running: live.length,
    stopped: docks.filter((d) => STOPPED.includes(d.state)).length,
    vcpusInUse: live.reduce((sum, d) => sum + (d.cpus ?? 0), 0),
    memoryMiBInUse: live.reduce((sum, d) => sum + (d.memoryMiB ?? 0), 0),
  };
}

type Dated = { stateChangedAt?: string; updatedAt?: string; createdAt?: string };

function stamp(item: Dated): number {
  const t = new Date(item.stateChangedAt ?? item.updatedAt ?? item.createdAt ?? '').getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Most recently changed first. */
export function recentItems<T extends Dated>(items: T[], limit = 5): T[] {
  return [...items].sort((a, b) => stamp(b) - stamp(a)).slice(0, limit);
}

/** "3 GB" style memory; whole numbers drop the decimal. */
export function formatMemoryInUse(mib: number): string {
  const gb = mib / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export interface ChecklistInput {
  docks: number | null;
  sshKeys: number | null;
  githubLinked: boolean | null;
  environments: number | null;
}

export interface ChecklistItem {
  id: 'dock' | 'ssh' | 'github' | 'environment';
  label: string;
  href: string;
  done: boolean;
}

/** Unknown (failed) checks count as done so a quiet failure never nags. */
export function gettingStarted(input: ChecklistInput): { items: ChecklistItem[]; allDone: boolean } {
  const items: ChecklistItem[] = [
    { id: 'dock', label: 'Create a dock', href: '/docks?new=1', done: input.docks === null || input.docks > 0 },
    { id: 'ssh', label: 'Add an SSH key', href: '/developers/ssh-keys', done: input.sshKeys === null || input.sshKeys > 0 },
    { id: 'github', label: 'Install the GitHub App', href: '/developers/github', done: input.githubLinked === null || input.githubLinked },
    { id: 'environment', label: 'Create an environment', href: '/environments', done: input.environments === null || input.environments > 0 },
  ];
  return { items, allDone: items.every((i) => i.done) };
}
