import { execFile } from 'node:child_process';
import type { ExecResult, Handle, Provider, ProviderInfo, Size } from './types.ts';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the dock binary with args; never rejects on a non-zero exit. */
export type CliRunner = (args: string[]) => Promise<CliResult>;

export interface DockLocalOptions {
  /** Path of the `dock` binary. */
  bin?: string;
  run?: CliRunner;
  /** Size of every dock; defaults to the CLI's own 2 CPUs and 10 GiB with 2048 MiB of memory. */
  size?: Size;
  timeoutMs?: number;
}

export const LOCAL_SIZE: Size = { cpus: 2, memoryMiB: 2048, diskGiB: 10 };

interface DockView {
  id: string;
  name?: string;
  runtime?: string;
}

const benchName = () => `bench-${crypto.randomUUID().slice(0, 12)}`;

/** The error line of a CLI failure: the `error:` line when there is one, else the last line, without terminal escapes. */
export function lastLine(stderr: string): string {
  const lines = stderr
    .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[A-Za-z]|\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.findLast((l) => l.startsWith('error:')) ?? lines.at(-1) ?? '').slice(0, 200);
}

export function cliRunner(bin: string, timeoutMs: number): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
      });
    });
}

/** Measures the local engine of the `dock` CLI (QEMU on this machine) by driving it with `--json`. */
export class DockLocalProvider implements Provider {
  readonly name = 'dock-local';
  readonly supports = { stopResume: true, branch: true };
  private readonly bin: string;
  private readonly run: CliRunner;
  private readonly size: Size;
  private runtime?: string;

  constructor(opts: DockLocalOptions = {}) {
    this.bin = opts.bin ?? 'dock';
    this.run = opts.run ?? cliRunner(this.bin, opts.timeoutMs ?? 180_000);
    this.size = opts.size ?? LOCAL_SIZE;
  }

  private async ok(args: string[]): Promise<string> {
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`dock ${args[0]} exited ${r.code}: ${lastLine(r.stderr)}`);
    return r.stdout;
  }

  private spec(size: Size): string[] {
    return ['--cpus', String(size.cpus), '--memory', `${size.memoryMiB}mb`, '--disk', `${size.diskGiB}gb`];
  }

  async create(size: Size = this.size): Promise<Handle> {
    const name = benchName();
    try {
      const dock = JSON.parse(await this.ok(['new', name, ...this.spec(size), '--json'])) as DockView;
      this.runtime ??= dock.runtime;
      return { id: dock.id };
    } catch (err) {
      // A failed or timed-out create may still have left the dock behind; find it by its unique name.
      await this.reclaim(name);
      throw err;
    }
  }

  private async reclaim(name: string): Promise<void> {
    try {
      const docks = JSON.parse(await this.ok(['ls', '--all', '--json'])) as DockView[];
      await Promise.allSettled(docks.filter((d) => d.name === name).map((d) => this.destroy({ id: d.id })));
    } catch {
      // Nothing more to do; TrackedProvider reports anything left over.
    }
  }

  async exec(handle: Handle, cmd: string): Promise<ExecResult> {
    // A non-zero command exit makes the CLI exit non-zero too but it still prints the result.
    const r = await this.run(['exec', handle.id, '--json', '--', cmd]);
    try {
      const out = JSON.parse(r.stdout) as { exitCode: number; stdout?: string };
      return { exitCode: out.exitCode, stdout: out.stdout ?? '' };
    } catch {
      throw new Error(`dock exec exited ${r.code}: ${lastLine(r.stderr) || 'no output'}`);
    }
  }

  async stop(handle: Handle): Promise<void> {
    await this.ok(['stop', handle.id, '--json']);
  }

  async resume(handle: Handle): Promise<void> {
    await this.ok(['resume', handle.id, '--json']);
  }

  async branch(handle: Handle, n: number): Promise<Handle[]> {
    // The local engine stops the source, copies its disk n times and resumes it, all in one command.
    const r = await this.run(['branch', handle.id, '--count', String(n), '--json']);
    let made: DockView[] = [];
    try {
      const out = JSON.parse(r.stdout) as DockView | DockView[];
      made = Array.isArray(out) ? out : [out];
    } catch {
      // No copy was reported.
    }
    if (r.code !== 0) {
      // On a partial failure the CLI still prints the copies it made; do not leak them.
      await Promise.allSettled(made.map((d) => this.destroy({ id: d.id })));
      throw new Error(`dock branch exited ${r.code}: ${lastLine(r.stderr)}`);
    }
    return made.map((d) => ({ id: d.id }));
  }

  async destroy(handle: Handle): Promise<void> {
    const r = await this.run(['rm', handle.id, '--json']);
    if (r.code !== 0 && !/not_found|no such dock/i.test(r.stderr)) {
      throw new Error(`dock rm exited ${r.code}: ${lastLine(r.stderr)}`);
    }
  }

  async info(): Promise<ProviderInfo> {
    const r = await this.run(['version']);
    return { version: r.code === 0 ? r.stdout.trim() : undefined, runtime: this.runtime };
  }
}
