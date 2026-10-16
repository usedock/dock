import { describe, expect, it } from 'vitest';
import { dockActions, dockStateLabel } from './dock-state';

describe('dockStateLabel', () => {
  it('shows stopped and stopping for archived states', () => {
    expect(dockStateLabel('archived')).toBe('stopped');
    expect(dockStateLabel('archiving')).toBe('stopping');
  });

  it('leaves other states unchanged', () => {
    expect(dockStateLabel('ready')).toBe('ready');
    expect(dockStateLabel('error')).toBe('error');
  });
});

describe('dockActions', () => {
  it.each(['ready', 'idle', 'running'])('allows stop and branch but not resume when %s', (state) => {
    expect(dockActions(state, 'microvm')).toEqual({ canStop: true, canResume: false, canBranch: true, busy: false });
  });

  it('allows resume but not branch on a stopped microVM dock', () => {
    expect(dockActions('archived', 'microvm')).toEqual({ canStop: false, canResume: true, canBranch: false, busy: false });
    expect(dockActions('archived')).toMatchObject({ canBranch: false });
  });

  it('allows branch on a stopped gVisor dock, whose work disk stays on the host', () => {
    expect(dockActions('archived', 'gvisor')).toEqual({ canStop: false, canResume: true, canBranch: true, busy: false });
  });

  it.each(['provisioning', 'provisioned', 'cloning', 'archiving'])('is busy with no actions when %s', (state) => {
    expect(dockActions(state, 'microvm')).toEqual({ canStop: false, canResume: false, canBranch: false, busy: true });
  });

  it.each(['error', 'unreachable'])('allows only stop when %s', (state) => {
    expect(dockActions(state, 'microvm')).toEqual({ canStop: true, canResume: false, canBranch: false, busy: false });
  });
});
