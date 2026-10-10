export interface Size {
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
}

export const DEFAULT_SIZE: Size = { cpus: 2, memoryMiB: 4096, diskGiB: 20 };

export interface Handle {
  id: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
}

export interface ProviderInfo {
  version?: string;
  runtime?: string;
}

export class UnsupportedError extends Error {}

export interface Provider {
  name: string;
  supports: { stopResume: boolean; branch: boolean };
  /** One-time setup (SDK load, workspace lookup) run before any clock starts. */
  prepare?(): Promise<void>;
  create(size?: Size): Promise<Handle>;
  exec(handle: Handle, cmd: string): Promise<ExecResult>;
  stop(handle: Handle): Promise<void>;
  resume(handle: Handle): Promise<void>;
  branch(handle: Handle, n: number): Promise<Handle[]>;
  destroy(handle: Handle): Promise<void>;
  info(): Promise<ProviderInfo>;
}
