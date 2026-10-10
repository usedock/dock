import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendSrc = join(root, '..', 'apps', 'backend', 'src');

interface HttpOp { method: string; path: string; status: number; body?: string[]; query?: string[]; headers?: Record<string, string> }
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
