import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { APPLY_SCRIPT_MAX_BYTES, buildApplyScripts, cloneTokenVar, type ApplyBundle } from './env-apply-script';

const repo = (overrides: Partial<ApplyBundle['repos'][number]> = {}) => ({
  id: 'r1',
  provider: 'github' as const,
  repositoryId: '1',
  fullName: 'acme/web',
  baseBranch: null,
  setupScript: null,
  ...overrides,
});

describe('buildApplyScripts', () => {
  let home: string;
  let bin: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dock-apply-'));
    bin = join(home, '.test-bin');
    mkdirSync(bin);
    // Fake git: clone creates the target with a tracked file, logs its args.
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/bash\necho "$@" >> "$HOME/.git-calls"\ncase "$*" in *missing*) exit 128;; esac\nfor last; do :; done\nmkdir -p "$last/.git" && echo tracked > "$last/.env" && echo readme > "$last/README"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function run(bundle: ApplyBundle, env: Record<string, string> = {}): void {
    for (const script of buildApplyScripts(bundle).scripts) {
      execFileSync('bash', ['-c', script], { env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } });
    }
  }

  async function settledStatus(): Promise<string> {
    const path = join(home, '.dock/setup.status');
    for (let i = 0; i < 200; i++) {
      const value = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
      if (value && value !== 'running') return value;
      await new Promise((r) => setTimeout(r, 20));
    }
    return 'timeout';
  }

  function shellVar(name: string): string {
    return execFileSync('bash', ['-c', `. "$HOME/.dock/env.sh"; printf '%s' "$${name}"`], { env: { HOME: home } }).toString();
  }

  async function waitFor(path: string): Promise<void> {
    for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
  }

  it('writes an env file every shell sources, quoting values exactly', () => {
    run({ vars: { A: 'plain', TRICKY: `it's "x" $HOME\nline2` }, files: [], repos: [] });
    expect(shellVar('A')).toBe('plain');
    expect(shellVar('TRICKY')).toBe(`it's "x" $HOME\nline2`);
    expect(statSync(join(home, '.dock/env.sh')).mode & 0o777).toBe(0o600);
    for (const rc of ['.bashrc', '.profile']) expect(readFileSync(join(home, rc), 'utf8')).toContain('.dock/env.sh');
  });

  it('is idempotent and replaces withheld vars instead of keeping them', () => {
    run({ vars: { KEEP: '1', SECRET: 's' }, files: [], repos: [] });
    run({ vars: { KEEP: '2' }, files: [], repos: [] });
    expect(shellVar('KEEP')).toBe('2');
    expect(shellVar('SECRET')).toBe('');
    expect(readFileSync(join(home, '.bashrc'), 'utf8').match(/dock\/env\.sh/g)).toHaveLength(2);
  });

  it('skips names a shell cannot export', () => {
    run({ vars: { 'BAD-NAME': 'x', GOOD: 'y' }, files: [], repos: [] });
    expect(readFileSync(join(home, '.dock/env.sh'), 'utf8')).not.toContain('BAD-NAME');
    expect(shellVar('GOOD')).toBe('y');
  });

  it('writes secret files and deletes ones dropped from the bundle', () => {
    run({ vars: {}, files: [{ path: 'app/.env', contents: 'X=1\n' }, { path: 'key.pem', contents: 'pem' }], repos: [] });
    expect(readFileSync(join(home, 'app/.env'), 'utf8')).toBe('X=1\n');
    expect(statSync(join(home, 'key.pem')).mode & 0o777).toBe(0o600);
    run({ vars: {}, files: [{ path: 'app/.env', contents: 'X=2\n' }], repos: [] });
    expect(readFileSync(join(home, 'app/.env'), 'utf8')).toBe('X=2\n');
    expect(existsSync(join(home, 'key.pem'))).toBe(false);
    run({ vars: {}, files: [], repos: [] });
    expect(existsSync(join(home, 'app/.env'))).toBe(false);
  });

  it('splits large files across scripts that each fit one argv', () => {
    const big = 'x'.repeat(250_000);
    const { scripts } = buildApplyScripts({ vars: {}, files: [{ path: 'big.txt', contents: big }], repos: [] });
    expect(scripts.length).toBeGreaterThan(1);
    for (const script of scripts) expect(Buffer.byteLength(script)).toBeLessThanOrEqual(APPLY_SCRIPT_MAX_BYTES);
    run({ vars: {}, files: [{ path: 'big.txt', contents: big }], repos: [] });
    expect(readFileSync(join(home, 'big.txt'), 'utf8')).toBe(big);
  });

  it('clones repos in the background with secret files winning, then runs setup', async () => {
    run({
      vars: { GH_TOKEN: 'tok' },
      files: [{ path: 'web/.env', contents: 'SECRET=1\n' }],
      repos: [repo({ baseBranch: 'develop', setupScript: 'touch "$HOME/setup-ran"' })],
      setupScript: 'touch "$HOME/dock-setup-ran"',
    });
    await waitFor(join(home, 'dock-setup-ran'));
    expect(readFileSync(join(home, 'web/.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(home, 'web/README'), 'utf8')).toBe('readme\n');
    expect(existsSync(join(home, 'setup-ran'))).toBe(true);
    expect(statSync(join(home, 'web/README')).mode & 0o777).toBe(0o644);
    expect(statSync(join(home, 'web/.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, '.dock/setup.log'), 'utf8')).toBe('');
    const calls = readFileSync(join(home, '.git-calls'), 'utf8');
    expect(calls).toContain('--branch develop https://github.com/acme/web.git');
    expect(calls).toContain('http.extraHeader=Authorization: Basic');
    expect(calls).not.toContain('tok ');
  });

  it('reports done at once when nothing runs in the background', () => {
    const out = buildApplyScripts({ vars: {}, files: [], repos: [] });
    expect(out.background).toBe(false);
    run({ vars: {}, files: [], repos: [] });
    expect(readFileSync(join(home, '.dock/setup.status'), 'utf8')).toBe('done\n');
  });

  it('settles setup.status to done or the failed steps', async () => {
    expect(buildApplyScripts({ vars: {}, files: [], repos: [repo()] }).background).toBe(true);
    run({ vars: {}, files: [], repos: [repo()] });
    expect(await settledStatus()).toBe('done');
    run({
      vars: {},
      files: [],
      repos: [repo({ id: 'r2', fullName: 'acme/missing' }), repo({ id: 'r3', fullName: 'acme/api', setupScript: 'exit 3' })],
      setupScript: 'false',
    });
    expect(await settledStatus()).toBe('clone:missing setup:api setup:dock');
  });

  it('prefers the platform clone token over env tokens', async () => {
    const r = repo();
    run({ vars: { GH_TOKEN: 'user-token' }, files: [], repos: [r] }, { [cloneTokenVar(r)]: 'platform-token' });
    await settledStatus();
    const header = /Basic (\S+)/.exec(readFileSync(join(home, '.git-calls'), 'utf8'))?.[1] ?? '';
    expect(Buffer.from(header, 'base64').toString()).toBe('x-access-token:platform-token');
  });

  it('never re-clones an existing checkout', async () => {
    mkdirSync(join(home, 'web/.git'), { recursive: true });
    run({ vars: {}, files: [], repos: [repo()], setupScript: 'touch "$HOME/done"' });
    await waitFor(join(home, 'done'));
    expect(existsSync(join(home, '.git-calls'))).toBe(false);
  });
});
