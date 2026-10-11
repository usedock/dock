import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { resolveBash } from './resolve-bash';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendSrc = join(root, '..', 'apps', 'backend', 'src');

interface HttpOp { method: string; path: string; status: number; body?: string[]; query?: string[]; headers?: Record<string, string>; optionalHeaders?: string[] }
interface CompositeOp { via: string; args: string[]; command: string; data: Record<string, string> }
interface Ops { http: Record<string, HttpOp>; composite: Record<string, CompositeOp> }
interface Step { id: string; op: string; args?: Record<string, unknown>; capture?: Record<string, string> }
interface Scenario { name: string; steps: Step[]; cleanup?: { op: string; args?: Record<string, unknown> }[] }
interface Fixture {
  scenario: string;
  variables: Record<string, string>;
  exchanges: { step: string; request: { method: string; path: string }; response: { status: number } }[];
}

const ops = parse(readFileSync(join(root, 'ops.yaml'), 'utf8')) as Ops;
const opNames = new Set([...Object.keys(ops.http), ...Object.keys(ops.composite)]);
const files = readdirSync(join(root, 'scenarios')).filter((f) => f.endsWith('.yaml')).sort();
const scenarios = files.map((file) => ({ file, doc: parse(readFileSync(join(root, 'scenarios', file), 'utf8')) as Scenario }));

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(p);
    return e.name.endsWith('.controller.ts') ? [p] : [];
  });
}

const joinPath = (...parts: string[]) => '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');
const normalize = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, ':p');

function matchesTemplate(path: string, template: string): boolean {
  const a = path.split('/');
  const b = template.split('/');
  return a.length === b.length && b.every((seg, i) => /^\{.+\}$/.test(seg) || seg === a[i]);
}

// Real routes as "METHOD /v1/<controller prefix>/<method path>" with params normalized.
function backendRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of controllerFiles(backendSrc)) {
    const src = readFileSync(file, 'utf8');
    const prefix = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(src)?.[1] ?? '';
    for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g)) {
      routes.add(`${m[1].toUpperCase()} ${normalize(joinPath('v1', prefix, m[2] ?? ''))}`);
    }
  }
  return routes;
}

describe('ops.yaml', () => {
  const routes = backendRoutes();

  it('finds the docks controller routes', () => {
    expect(routes.has('POST /v1/docks/:p/exec')).toBe(true);
  });

  it.each(Object.entries(ops.http))('%s maps to a real backend route', (name, op) => {
    expect(routes, `${name}: ${op.method} ${op.path}`).toContain(`${op.method} ${normalize(op.path)}`);
  });

  it.each(Object.entries(ops.composite))('%s is built on an http op', (name, op) => {
    expect(ops.http[op.via], name).toBeDefined();
    expect(op.args).toContain('dockId');
  });

  it('lists the optional headers the controller reads', () => {
    const src = readFileSync(join(backendSrc, 'docks', 'docks.controller.ts'), 'utf8');
    expect(src).toContain("@Headers('idempotency-key')");
    expect(ops.http['docks.exec'].optionalHeaders).toEqual(['idempotency-key']);
  });

  it('keeps http and composite names apart', () => {
    for (const name of Object.keys(ops.composite)) expect(ops.http[name]).toBeUndefined();
  });
});

describe('scenarios', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schema', 'scenario.schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true }).compile(schema);

  it('has the required flows', () => {
    expect(files).toEqual([
      'branch-copies-files.yaml',
      'create-exec-delete.yaml',
      'files-roundtrip.yaml',
      'list-connectors.yaml',
      'list-images.yaml',
      'not-found-errors.yaml',
      'size-validation-errors.yaml',
      'stop-resume-keeps-files.yaml',
    ]);
  });

  it.each(scenarios)('$file matches the schema', ({ file, doc }) => {
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(`${doc.name}.yaml`).toBe(file);
  });

  it.each(scenarios)('$file uses only known ops with known args', ({ doc }) => {
    for (const step of [...doc.steps, ...(doc.cleanup ?? [])]) {
      expect(opNames.has(step.op), `unknown op ${step.op}`).toBe(true);
      const http = ops.http[step.op];
      const allowed = new Set(
        http
          ? [...(http.path.match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1)), ...(http.body ?? []), ...(http.query ?? [])]
          : ops.composite[step.op].args,
      );
      for (const arg of Object.keys(step.args ?? {})) expect(allowed.has(arg), `${step.op} has no arg ${arg}`).toBe(true);
    }
  });

  it.each(scenarios)('$file has unique step ids and only uses captured variables', ({ doc }) => {
    const ids = doc.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(['workspaceId', 'run']);
    const refs = (value: unknown) => [...JSON.stringify(value ?? {}).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
    for (const step of doc.steps) {
      for (const name of refs(step)) expect(known.has(name), `${step.id} uses ${name} before it is captured`).toBe(true);
      for (const name of Object.keys(step.capture ?? {})) known.add(name);
    }
    for (const step of doc.cleanup ?? []) {
      for (const name of refs(step)) expect(known.has(name), `cleanup uses ${name}`).toBe(true);
    }
  });

  it.each(scenarios)('$file has a fixture with an exchange per step', ({ doc }) => {
    const path = join(root, 'fixtures', `${doc.name}.json`);
    expect(existsSync(path)).toBe(true);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
    expect(fixture.scenario).toBe(doc.name);
    expect(Object.keys(fixture.variables).sort()).toEqual(['run', 'workspaceId']);
    const byStep = new Map(fixture.exchanges.map((e) => [e.step, e]));
    for (const step of doc.steps) {
      const exchange = byStep.get(step.id);
      expect(exchange, `fixture lacks step ${step.id}`).toBeDefined();
      const http = ops.http[ops.composite[step.op]?.via ?? step.op];
      expect(exchange!.request.method).toBe(http.method);
      expect(matchesTemplate(exchange!.request.path, http.path), `${step.id}: ${exchange!.request.path}`).toBe(true);
    }
    const stepIds = new Set(doc.steps.map((s) => s.id));
    for (const e of fixture.exchanges) {
      expect(stepIds.has(e.step) || /^cleanup\.\d+$/.test(e.step), `fixture has stray step ${e.step}`).toBe(true);
    }
  });
});

// POSIX single-quote escaping, the same as the backend's shellQuote.
const b64decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');
const shellWord = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function renderCommand(op: CompositeOp, args: Record<string, string>): string {
  const b64 = Buffer.from(args.content ?? '', 'utf8').toString('base64');
  return op.command.replace(/\{path\}/g, () => shellWord(args.path)).replace(/\{contentBase64\}/g, b64);
}

function subsetMatch(want: unknown, got: unknown): boolean {
  if (want === '$any') return got !== null && got !== undefined;
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => subsetMatch(w, got[i]));
  if (want && typeof want === 'object') {
    return !!got && typeof got === 'object' && Object.entries(want).every(([k, w]) => subsetMatch(w, (got as Record<string, unknown>)[k]));
  }
  return want === got;
}

function substitute(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\$\{(\w+)\}$/.exec(value);
    return whole ? vars[whole[1]] : value.replace(/\$\{(\w+)\}/g, (_, n: string) => String(vars[n]));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

// Reference offline runner: the fixtures must satisfy their scenario under the README's fake-server rules.
describe('fixture replay', () => {
  interface Exchange { request: { method: string; path: string; body?: unknown; headers?: unknown }; response: { status: number; body: Record<string, any> } }

  it.each(scenarios)('$file passes against its fixture', ({ doc }) => {
    const fixture = JSON.parse(readFileSync(join(root, 'fixtures', `${doc.name}.json`), 'utf8')) as { variables: Record<string, string>; exchanges: Exchange[] };
    const vars: Record<string, unknown> = { ...fixture.variables };
    const used = new Set<number>();
    const call = (opName: string, args: Record<string, any>) => {
      const composite = ops.composite[opName];
      const http = ops.http[composite?.via ?? opName];
      const path = http.path.replace(/\{(\w+)\}/g, (_, n: string) => args[n]);
      const body: Record<string, unknown> = {};
      const headers: Record<string, string> = {};
      if (composite) body.command = renderCommand(composite, args);
      else for (const k of http.body ?? []) if (args[k] !== undefined) body[k] = args[k];
      for (const [h, t] of Object.entries(http.headers ?? {})) headers[h] = t.replace(/\{(\w+)\}/g, (_, n: string) => args[n]);
      const i = fixture.exchanges.findIndex((e, idx) => !used.has(idx) && e.request.method === http.method && e.request.path === path
        && subsetMatch(e.request.body ?? {}, body) && subsetMatch(e.request.headers ?? {}, headers));
      if (i < 0) return { status: 404, body: { ok: false, code: 'dock_not_found' } as Record<string, any>, miss: `${http.method} ${path} ${JSON.stringify(body)}` };
      used.add(i);
      const { status, body: res } = structuredClone(fixture.exchanges[i].response);
      if (composite && res.ok) {
        expect(res.data.exitCode, `${opName} exit code`).toBe(0);
        const out = res.data.stdout as string;
        res.data = opName.endsWith('.write') ? { path: args.path } : opName.endsWith('.read')
          ? { content: b64decode(out) } : { entries: out.split('\n').filter(Boolean).map(b64decode) };
      }
      return { status, body: res, miss: undefined };
    };
    for (const step of doc.steps as (Step & { expect: Record<string, any> })[]) {
      const res = call(step.op, substitute(step.args ?? {}, vars) as Record<string, any>);
      expect(res.miss, `${step.id}: no exchange matches`).toBeUndefined();
      for (const [name, p] of Object.entries(step.capture ?? {})) vars[name] = p.split('.').reduce<any>((o, k) => o?.[k], res.body);
      const want = substitute(step.expect, vars) as Record<string, any>;
      expect([res.status, res.body.ok], step.id).toEqual([want.status ?? ops.http[ops.composite[step.op]?.via ?? step.op].status, want.ok]);
      if (want.code) expect(res.body.code, step.id).toBe(want.code);
      if (want.data !== undefined) expect(subsetMatch(want.data, res.body.data), `${step.id}: ${JSON.stringify(res.body.data)}`).toBe(true);
    }
    for (const step of doc.cleanup ?? []) call(step.op, substitute(step.args ?? {}, vars) as Record<string, any>);
    expect(fixture.exchanges.map((_, i) => i).filter((i) => !used.has(i)), 'unused exchanges').toEqual([]);
  });
});

// The file templates run in bash with GNU coreutils, as in the dock image.
// On Windows only Git Bash (or DOCK_TEST_BASH) is used, never the WSL launcher.
const resolved = resolveBash({ platform: process.platform, env: process.env, exists: existsSync });
if (resolved.reason) console.warn(`composite file commands skipped: ${resolved.reason}`);
const bashPath = resolved.bash;
const bashRun = (command: string, cwd?: string) =>
  bashPath ? spawnSync(bashPath, ['-c', command], { cwd, env: resolved.env, encoding: 'utf8' }) : undefined;
const bash = bashRun('base64 -w0 </dev/null');
// Some filesystems (NTFS) cannot hold newlines in names; the newline cases skip there.
const nl = bashRun('d=$(mktemp -d) && touch "$d/a"$\'\\n\'"b" && rm -r "$d"');
const canNewline = bash?.status === 0 && nl?.status === 0;
const hostileNames = ["it's.txt", '-n.txt', 'dir with space/$(touch pwned).txt', "x'; touch pwned; echo '", 'a\nb.txt', 'trail\n', '\nlead.txt', 'a\n\nb'];
const names = hostileNames.filter((n) => canNewline || !n.includes('\n'));
const flat = (name: string) => name.replace(/\//g, '_');

// CI must run these, never skip them silently.
if (process.env.CI) it('bash with GNU coreutils is usable in CI', () => expect(bash?.status, resolved.reason).toBe(0));

describe.skipIf(bash?.status !== 0)('composite file commands', () => {
  const run = (cwd: string, command: string) => bashRun(command, cwd)!;
  const inTempDir = (fn: (cwd: string) => void) => {
    const cwd = mkdtempSync(join(tmpdir(), 'sdk-scenarios-'));
    try {
      fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  it.each(names)('round-trips %j without running it', (name) => {
    inTempDir((cwd) => {
      const content = "line 1\n'quoted' $HOME `x`\n";
      const write = run(cwd, renderCommand(ops.composite['docks.files.write'], { path: name, content }));
      expect(write.status, write.stderr).toBe(0);
      const read = run(cwd, renderCommand(ops.composite['docks.files.read'], { path: name }));
      expect(read.status, read.stderr).toBe(0);
      expect(b64decode(read.stdout)).toBe(content);
      expect(existsSync(join(cwd, 'pwned'))).toBe(false);
    });
  });

  it.each(names)('lists a directory holding %j and a directory named %j', (name) => {
    inTempDir((cwd) => {
      const entry = flat(name);
      for (const dir of [`d/${entry}`, `e/${entry}/`]) {
        const write = (path: string) => run(cwd, renderCommand(ops.composite['docks.files.write'], { path, content: 'x' }));
        expect(write(`${dir.replace(/\/$/, '')}/${entry}`).status).toBe(0);
        expect(write(`${dir.replace(/\/$/, '')}/plain.txt`).status).toBe(0);
        const list = run(cwd, renderCommand(ops.composite['docks.files.list'], { path: dir }));
        expect(list.status, list.stderr).toBe(0);
        expect(list.stdout.split('\n').filter(Boolean).map(b64decode).sort()).toEqual([entry, 'plain.txt'].sort());
      }
      expect(existsSync(join(cwd, 'pwned'))).toBe(false);
    });
  });

  // find skips a symlinked start point and reads a leading -, ! or ( as an expression.
  it.each(['link', '-n.txt', '!', '(', 'link/'])('lists the entries of directory %j', (path) => {
    inTempDir((cwd) => {
      for (const dir of ['real', '-n.txt', '!', '(']) {
        mkdirSync(join(cwd, dir));
        writeFileSync(join(cwd, dir, 'a.txt'), 'x');
      }
      symlinkSync(join(cwd, 'real'), join(cwd, 'link'), 'junction');
      const list = run(cwd, renderCommand(ops.composite['docks.files.list'], { path }));
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout.split('\n').filter(Boolean).map(b64decode)).toEqual(['a.txt']);
    });
  });

  it('lists an empty directory and fails on a missing one', () => {
    inTempDir((cwd) => {
      run(cwd, 'mkdir empty');
      const empty = run(cwd, renderCommand(ops.composite['docks.files.list'], { path: 'empty' }));
      expect([empty.status, empty.stdout]).toEqual([0, '']);
      expect(run(cwd, renderCommand(ops.composite['docks.files.list'], { path: 'nope' })).status).not.toBe(0);
    });
  });
});
