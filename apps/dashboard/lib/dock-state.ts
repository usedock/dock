const LABELS: Record<string, string> = { archived: 'stopped', archiving: 'stopping' };
// Backend stop accepts these; error and unreachable docks can be stopped to recover.
const STOPPABLE = ['ready', 'idle', 'running', 'error', 'unreachable'];
const BUSY = ['provisioning', 'provisioned', 'cloning', 'archiving'];

/** The user-facing name of an API dock state; the API value is unchanged. */
export function dockStateLabel(state: string): string {
  return LABELS[state] ?? state;
}

/** Lifecycle actions a dock state allows, matching the backend transitions. */
export function dockActions(state: string): { canStop: boolean; canResume: boolean; canBranch: boolean; busy: boolean } {
  const busy = BUSY.includes(state);
  return {
    canStop: STOPPABLE.includes(state),
    canResume: state === 'archived',
    canBranch: !busy,
    busy,
  };
}
