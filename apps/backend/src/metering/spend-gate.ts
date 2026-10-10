/** Dock-mutation spend gate. The open core ships a no-op; a billing extension binds a real one. */
export abstract class SpendGate {
  /** False when no billing is active: gates pass and money moves are refused; metering still records. */
  abstract readonly enabled: boolean;
  abstract requireSpend(orgId: string): Promise<void>;
  abstract requireFastRunSpend(orgId: string, excludeRunId?: string): Promise<void>;
}

/** Default gate: always allows. */
export class NoopSpendGate extends SpendGate {
  readonly enabled = false;

  async requireSpend(): Promise<void> {}

  async requireFastRunSpend(): Promise<void> {}
}
