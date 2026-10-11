import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Convention: a route is documented when some page under documentation/content
// contains the literal text `METHOD /v1/path`. Path params may be written as
// `:id` or `{id}` and their names do not have to match the controller's.
// Parsed from source, not booted: routes added with @All() are not seen.

const SRC = __dirname;
const CONTENT = resolve(__dirname, '../../../documentation/content');
const METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

/** Routes that are not public API. A trailing slash means a prefix. */
const INTERNAL: Record<string, string> = {
  '/v1/fleet/': 'docklet-to-control-plane API, authenticated by host credentials',
  'GET /v1/health': 'liveness probe',
  'GET /v1/ready': 'readiness probe',
  'GET /v1/ports/tls-check': 'edge on-demand TLS check called by the proxy',
  'POST /v1/github/webhooks': 'GitHub webhook receiver, verified by signature',
  'POST /v1/github/runs/:p/complete': 'completion callback used only by the run dock',
  'GET /v1/dev/mail/:p': 'dev-only mail template preview, 404 in production',
};

function walk(dir: string, match: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path, match);
    return match(path) ? [path] : [];
  });
}

function normalize(method: string, path: string): string {
  const segments = path
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => (/^(:\w+|\{\w+\})$/.test(segment) ? ':p' : segment));
  return `${method.toUpperCase()} ${segments.join('/')}`;
}

function joinPath(prefix: string, path: string): string {
  return `/v1/${[prefix, path].filter(Boolean).join('/')}`.replace(/\/+$/, '');
}

/** Routes in one controller file, plus any decorator in a form the regexes do not read. */
function parseController(source: string): { routes: string[]; unparsed: string[] } {
  const controllers = [...source.matchAll(/@Controller\(\s*(?:'([^']*)')?\s*\)/g)];
  const unparsed = [...source.matchAll(new RegExp(`@(?:Controller|Version|${METHODS.join('|')})\\([^)]*\\)?`, 'g'))]
    .map((m) => m[0])
    .filter((text) => !/^@(?:Controller|Get|Post|Put|Patch|Delete)\(\s*(?:'[^']*')?\s*\)$/.test(text));
  if (controllers.length > 1) unparsed.push('more than one @Controller in the file');
  const prefix = controllers[0]?.[1] ?? '';
  const decorator = new RegExp(`@(${METHODS.join('|')})\\(\\s*(?:'([^']*)')?\\s*\\)`, 'g');
  const routes = [...source.matchAll(decorator)].map((match) => normalize(match[1], joinPath(prefix, match[2] ?? '')));
  return { routes, unparsed };
}

function controllerRoutes(): string[] {
  const routes: string[] = [];
  const unparsed: string[] = [];
  for (const file of walk(SRC, (f) => f.endsWith('.controller.ts'))) {
    const parsed = parseController(readFileSync(file, 'utf8'));
    routes.push(...parsed.routes);
    unparsed.push(...parsed.unparsed.map((text) => `${file}: ${text}`));
  }
  // A decorator form the parser cannot read would drop its routes and pass silently.
  expect(unparsed, 'Route decorators the docs coverage parser cannot read').toEqual([]);
  return [...new Set(routes)].sort();
}

function documentedRoutes(): Set<string> {
  const found = new Set<string>();
  const mention = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[A-Za-z0-9_\-.:{}/]*)/g;
  for (const file of walk(CONTENT, (f) => /\.mdx?$/.test(f))) {
    for (const match of readFileSync(file, 'utf8').matchAll(mention)) {
      found.add(normalize(match[1], match[2].replace(/[.:,]+$/, '')));
    }
  }
  return found;
}

function isInternal(route: string): boolean {
  const path = route.slice(route.indexOf(' ') + 1);
  return Object.keys(INTERNAL).some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : entry === route));
}

describe('docs coverage parser', () => {
  it('reads string prefixes and paths, including multi-line ones', () => {
    const source = `@Controller('things')
class A {
  @Get()
  a() {}
  @Post(
    ':id/run'
  )
  b() {}
}`;
    expect(parseController(source)).toEqual({ routes: ['GET /v1/things', 'POST /v1/things/:p/run'], unparsed: [] });
  });

  it.each([
    "@Controller({ path: 'things' })",
    "@Controller(['a', 'b'])",
    '@Controller("things")',
    `@Controller('things')
@Get(['a', 'b'])`,
    `@Controller('things')
@Get(
  ':id',
)`,
    `@Controller('things')
@Version('2')
@Get()`,
    `@Controller('a')
class A {}
@Controller('b')`,
  ])('reports %j instead of skipping it', (source) => {
    expect(parseController(source).unparsed).not.toEqual([]);
  });
});

describe('docs route coverage', () => {
  const routes = controllerRoutes();

  it('finds the controller routes', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes).toContain('POST /v1/docks');
    expect(routes).toContain('GET /v1/docks/:p');
    expect(routes).toContain('POST /v1/environments/:p/secrets:reveal');
  });

  it('documents every public route', () => {
    const documented = documentedRoutes();
    const missing = routes.filter((route) => !isInternal(route) && !documented.has(route));
    expect(missing, `Routes with no \`METHOD /v1/path\` mention under documentation/content:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(INTERNAL).filter((entry) =>
      entry.endsWith('/') ? !routes.some((r) => r.includes(` ${entry}`)) : !routes.includes(entry),
    );
    expect(stale).toEqual([]);
  });
});
