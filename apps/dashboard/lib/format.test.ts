import { describe, expect, it } from 'vitest';
import { describeSkippedDocks } from './format';

describe('describeSkippedDocks', () => {
  it('lists the name with the reason, or the id for an unnamed dock', () => {
    expect(
      describeSkippedDocks([
        { id: 'dock_1', name: 'api', reason: 'bound to a deleted environment' },
        { id: 'dock_2', name: null, reason: 'bound to a deleted environment' },
      ]),
    ).toEqual(['api: bound to a deleted environment', 'dock_2: bound to a deleted environment']);
  });

  it('is empty when nothing was skipped', () => {
    expect(describeSkippedDocks([])).toEqual([]);
  });
});
