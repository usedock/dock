const LABELS: Record<string, string> = { archived: 'stopped', archiving: 'stopping' };
// Backend stop accepts these; error and unreachable docks can be stopped to recover.
const STOPPABLE = ['ready', 'idle', 'running', 'error', 'unreachable'];
const BUSY = ['provisioning', 'provisioned', 'cloning', 'archiving'];
// Branch captures the source on its host, so the source must be live.
const LIVE = ['ready', 'idle', 'running'];

/** The user-facing name of an API dock state; the API value is unchanged. */
export function dockStateLabel(state: string): string {
  return LABELS[state] ?? state;
}

/** Lifecycle actions a dock state allows, matching the backend transitions. */
export function dockActions(state: string, runtime?: string | null): { canStop: boolean; canResume: boolean; canBranch: boolean; busy: boolean } {
  return {
    canStop: STOPPABLE.includes(state),
    canResume: state === 'archived',
    // A stopped microVM has no VM to capture; a stopped gVisor dock keeps its work disk on the host.
    canBranch: LIVE.includes(state) || (state === 'archived' && runtime === 'gvisor'),
    busy: BUSY.includes(state),
  };
}
