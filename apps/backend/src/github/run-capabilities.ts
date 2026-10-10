export const RUN_CAPABILITY_VERSION = 1 as const;

export const RUN_CAPABILITIES = [
  'workspaceIsolation',
  'docker',
  'browser',
  'systemd',
  'sshTakeover',
  'persistentState',
  'networkPolicy',
  'credentialBroker',
] as const;

export type RunCapability = (typeof RUN_CAPABILITIES)[number];
export type RunCapabilities = Partial<Record<RunCapability, boolean>>;
export type RunExecutionTarget = 'dock' | 'fast';

export const FAST_MICROVM_CAPABILITIES: RunCapabilities = {
  workspaceIsolation: true,
  docker: true,
  browser: true,
  systemd: true,
  sshTakeover: false,
  persistentState: false,
  networkPolicy: true,
  credentialBroker: true,
};

export interface RuntimeCapabilityContract {
  version: number;
  target: string;
  profile: string;
  capabilities: RunCapabilities;
}

export class CapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityValidationError';
  }
}

/** Normalizes user input and rejects unknown or non-boolean capabilities. */
export function normalizeRunCapabilities(input: unknown): RunCapabilities {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new CapabilityValidationError('Capabilities must be an object');
  }

  const out: RunCapabilities = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(RUN_CAPABILITIES as readonly string[]).includes(key)) {
      throw new CapabilityValidationError(`Unknown capability: ${key}`);
    }
    if (typeof value !== 'boolean') {
      throw new CapabilityValidationError(`Capability ${key} must be boolean`);
    }
    out[key as RunCapability] = value;
  }
  return out;
}

export function assertRuntimeCapabilityContract(contract: RuntimeCapabilityContract): void {
  if (contract.version !== RUN_CAPABILITY_VERSION) throw new CapabilityValidationError(`Unsupported capability version: ${contract.version}`);
  if (contract.target !== 'dock' && contract.target !== 'fast') throw new CapabilityValidationError(`Unsupported execution target: ${contract.target}`);
  if (!contract.profile.trim()) throw new CapabilityValidationError('Capability profile is required');
  normalizeRunCapabilities(contract.capabilities);
}

/** Returns requested capabilities the provider cannot satisfy. */
export function missingRunCapabilities(
  requested: RunCapabilities,
  offered: RunCapabilities,
): RunCapability[] {
  return RUN_CAPABILITIES.filter((capability) => requested[capability] === true && offered[capability] !== true);
}

export function satisfiesRunCapabilities(requested: RunCapabilities, offered: RunCapabilities): boolean {
  return missingRunCapabilities(requested, offered).length === 0;
}
