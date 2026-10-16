import { Badge } from '@/components/ui/badge';
import { dockStateLabel } from '@/lib/dock-state';
import { cn } from '@/lib/utils';

type Tone = 'live' | 'idle' | 'warn' | 'error';

const TONE_DOT: Record<Tone, string> = {
  live: 'bg-emerald-500',
  idle: 'bg-stone-400',
  warn: 'bg-amber-500',
  error: 'bg-destructive',
};

/** Dock lifecycle states to the status-dot tone (emerald only ever means running). */
export const DOCK_STATE_TONE: Record<string, Tone> = {
  ready: 'live',
  running: 'live',
  provisioning: 'warn',
  provisioned: 'warn',
  cloning: 'warn',
  idle: 'idle',
  archiving: 'idle',
  archived: 'idle',
  error: 'error',
  unreachable: 'warn',
};

/** Run states to the status-dot tone. */
export const RUN_STATE_TONE: Record<string, Tone> = {
  pending: 'warn',
  provisioning: 'warn',
  working: 'warn',
  pr_opened: 'live',
  done: 'idle',
  failed: 'error',
  stopped: 'error',
};

/** Host heartbeat states to the status-dot tone. */
export const HOST_STATE_TONE: Record<string, Tone> = {
  online: 'live',
  offline: 'error',
};

/** Outline badge with a leading status dot; emerald is reserved for live/running. */
export function StatePill({ state, toneMap = DOCK_STATE_TONE }: { state: string; toneMap?: Record<string, Tone> }) {
  const tone = toneMap[state] ?? 'idle';
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone])} aria-hidden="true" />
      {dockStateLabel(state)}
    </Badge>
  );
}
