import { NoopSpendGate, SpendGate } from './spend-gate';

describe('NoopSpendGate', () => {
  const gate: SpendGate = new NoopSpendGate();

  it('is disabled and allows every spend', async () => {
    expect(gate.enabled).toBe(false);
    await expect(gate.requireSpend('org-1')).resolves.toBeUndefined();
    await expect(gate.requireFastRunSpend('org-1', 'run-1')).resolves.toBeUndefined();
  });
});
