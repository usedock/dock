import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, OperationObject, SwaggerModule, getSchemaPath } from '@nestjs/swagger';
import { ErrorEnvelopeDto } from './envelopes';
import { IS_PUBLIC_KEY } from './public.decorator';

const BEARER_SCHEME = 'bearer';
const ERROR_REF = { $ref: getSchemaPath(ErrorEnvelopeDto) };

// Plain require (not import) keeps package.json out of the tsc program, so the
// inferred output layout stays dist/main and the Docker CMD keeps working.
/** Package version; the served contract version is locked to the release. */
export function readApiVersion(): string {
  try {
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Builds the versioned contract, wrapped in envelopes and marked with auth. */
export function buildOpenApiDocument(app: INestApplication, apiUrl: string): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Dock API')
    .setDescription(
      [
        'Dock persistent-compute API: docks, environments, snapshots, and supporting resources.',
        'Every 2xx response is wrapped as `{ ok: true, data }`; every error is `{ ok: false, code, message }`.',
        'Protected operations take `Authorization: Bearer <token>` with a JWT access token or `dock_` API key.',
      ].join('\n'),
    )
    .setVersion(readApiVersion())
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT access token or dock_ API key.' },
      BEARER_SCHEME,
    )
    .addSecurityRequirements(BEARER_SCHEME)
    .addServer(apiUrl, 'Production')
    .addServer('http://localhost:8000', 'Local development')
    .build();
  const document = SwaggerModule.createDocument(app, config, { extraModels: [ErrorEnvelopeDto] });
  normalizePathTemplates(document);
  applyEnvelopeToDocument(document);
  applySecurityToDocument(document, collectPublicRoutes(app));
  return document;
}

// Express accepts `:name` glued inside a segment (e.g. `secrets:reveal`); the
// plugin renders it as `{name}`, which strict generators reject when the
// parameter is undeclared. Restore the literal `:name` source form instead.
export function normalizePathTemplates(document: OpenAPIObject): void {
  if (!document.paths) return;
  for (const [path, pathItem] of Object.entries(document.paths)) {
    const declared = new Set<string>();
    for (const candidate of Object.values(pathItem ?? {})) {
      const op = asOperation(candidate);
      if (!op) continue;
      for (const param of [...(pathItem?.parameters ?? []), ...(op.parameters ?? [])]) {
        if (typeof param !== 'object' || param === null || '$ref' in param) continue;
        if (!('name' in param) || !('in' in param)) continue;
        const { name, in: location } = param;
        if (location === 'path' && typeof name === 'string') declared.add(name);
      }
    }
    let fixed = path;
    for (const name of fixed.match(/\{([A-Za-z0-9_]+)\}/g) ?? []) {
      const bare = name.slice(1, -1);
      if (!declared.has(bare)) fixed = fixed.replace(name, `:${bare}`);
    }
    if (fixed !== path) {
      document.paths[fixed] = pathItem;
      delete document.paths[path];
    }
  }
}

/** Wraps every 2xx response as `{ ok, data }`; documents 400 where input exists. */
export function applyEnvelopeToDocument(document: OpenAPIObject): void {
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const candidate of Object.values(pathItem ?? {})) {
      const op = asOperation(candidate);
      if (!op) continue;
      for (const [status, response] of Object.entries(op.responses)) {
        if (!status.startsWith('2')) continue;
        const mutable = inlineResponse(response);
        if (!mutable) continue;
        // Controllers return raw payloads with no return-type metadata, so most
        // 2xx responses arrive schemaless; the wrapper is still documented.
        const data = mutable.content?.['application/json']?.schema ?? {};
        mutable.content = {
          ...(mutable.content ?? {}),
          'application/json': {
            schema: {
              type: 'object',
              required: ['ok', 'data'],
              properties: { ok: { type: 'boolean', example: true }, data },
            },
          },
        };
      }
      if ((op.requestBody ?? (op.parameters?.length ?? 0) > 0) && !op.responses['400']) {
        op.responses['400'] = errorResponse('Validation failed');
      }
    }
  }
}

/** Clears security on @Public() operations; pins bearer + 401 on the rest. */
export function applySecurityToDocument(document: OpenAPIObject, publicRoutes: ReadonlySet<string>): void {
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, candidate] of Object.entries(pathItem ?? {})) {
      const op = asOperation(candidate);
      if (!op) continue;
      if (publicRoutes.has(`${method.toUpperCase()} ${path}`)) {
        op.security = [];
      } else {
        op.security = [{ [BEARER_SCHEME]: [] }];
        op.responses['401'] ??= errorResponse('Missing or invalid bearer token');
        op.responses['403'] ??= errorResponse(
          'Forbidden; `dock_key_forbidden` when a dock-bound API key calls a route outside its own dock',
        );
      }
    }
  }
}

function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: ERROR_REF } } };
}

// Path items mix operations with shared `parameters`; only entries carrying
// `responses` are operations the envelope/security passes rewrite.
function asOperation(candidate: unknown): OperationObject | null {
  if (typeof candidate !== 'object' || candidate === null || !('responses' in candidate)) return null;
  const op: OperationObject = candidate as OperationObject;
  return op;
}

type OperationResponses = NonNullable<OperationObject['responses']>;
type ApiResponse = OperationResponses[keyof OperationResponses];
type InlineApiResponse = Exclude<ApiResponse, { $ref: string }>;

// $ref responses are shared pointers; only inline responses get rewritten.
function inlineResponse(response: ApiResponse): InlineApiResponse | null {
  if (typeof response !== 'object' || response === null || '$ref' in response) return null;
  return response;
}
/** Joins prefix/controller/method paths; `:id` becomes `{id}` to match OpenAPI keys. */
export function normalizeRoutePath(prefix: string, controllerPath: unknown, methodPath: unknown): string {
  const parts = [prefix, controllerPath, methodPath].flatMap((p) => (Array.isArray(p) ? p : [p]));
  const joined = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('/');
  // Nest drops trailing slashes when registering routes; the key must match.
  return `/${joined}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
}

const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

/** Reads the same IS_PUBLIC_KEY metadata the JwtAuthGuard enforces, keyed as `METHOD /v1/path`. */
export function collectPublicRoutes(app: INestApplication): Set<string> {
  const routes = new Set<string>();
  const reflector = app.get(Reflector);
  // Nest exposes no public container accessor; the runtime instance always carries it.
  const host: { container: { getModules(): Map<string, ModuleRef> } } = app as unknown as {
    container: { getModules(): Map<string, ModuleRef> };
  };
  for (const moduleRef of host.container.getModules().values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype);
      const proto = Object.getPrototypeOf(instance);
      // Controller handlers resolve through the prototype chain.
      const members: Record<string, unknown> = instance as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = members[name];
        if (typeof handler !== 'function') continue;
        if (!reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, metatype])) continue;
        const methodIndex = Reflect.getMetadata(METHOD_METADATA, handler);
        const method = typeof methodIndex === 'number' ? (REQUEST_METHODS[methodIndex] ?? 'ALL') : 'ALL';
        routes.add(
          `${method} ${normalizeRoutePath('v1', controllerPath, Reflect.getMetadata(PATH_METADATA, handler))}`,
        );
      }
    }
  }
  return routes;
}
interface NewableFunction {
  // never[] accepts every constructor signature; instances are never created here.
  new (...args: never[]): unknown;
}
interface ModuleRef {
  controllers: Map<string | symbol, { instance?: object; metatype?: NewableFunction }>;
}
