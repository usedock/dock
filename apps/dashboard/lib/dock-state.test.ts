import { describe, expect, it } from 'vitest';
import { branchDisabledReason, dockActions, dockStateLabel } from './dock-state';

describe('branchDisabledReason', () => {
  it('is null when branching is allowed', () => {
    expect(branchDisabledReason('ready', 'microvm')).toBeNull();
    expect(branchDisabledReason('archived', 'gvisor')).toBeNull();
  });

  it('asks to resume a stopped microVM dock', () => {
    expect(branchDisabledReason('archived', 'microvm')).toBe('Resume the dock to branch it');
  });

  it('asks to wait while a dock is transitioning', () => {
    expect(branchDisabledReason('archiving', 'microvm')).toBe('Wait for the dock to finish stopping');
    expect(branchDisabledReason('provisioning')).toBe('Wait for the dock to finish provisioning');
  });

  it('explains other states', () => {
    expect(branchDisabledReason('error')).toBe('Cannot branch a dock that is error');
  });
});

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
