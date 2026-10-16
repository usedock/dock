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
  it.each(['ready', 'idle', 'running'])('allows stop but not resume when %s', (state) => {
    expect(dockActions(state)).toMatchObject({ canStop: true, canResume: false, canBranch: true, busy: false });
  });

  it('allows resume and branch only when stopped', () => {
    expect(dockActions('archived')).toMatchObject({ canStop: false, canResume: true, canBranch: true, busy: false });
  });

  it.each(['provisioning', 'provisioned', 'cloning', 'archiving'])('is busy with no actions when %s', (state) => {
    expect(dockActions(state)).toEqual({ canStop: false, canResume: false, canBranch: false, busy: true });
  });

  it.each(['error', 'unreachable'])('allows stop but not resume when %s', (state) => {
    expect(dockActions(state)).toMatchObject({ canStop: true, canResume: false, busy: false });
  });
});
