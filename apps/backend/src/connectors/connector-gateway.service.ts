import { BadGatewayException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { RateLimitService } from '../auth/rate-limit.service';
import { hashToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { docks } from '../database/schema';
import { CONNECTOR_SPECS, apiBase, isConnectorKind, upstreamAuth, type ConnectorKind } from './connector-kinds';
import { ConnectorsService } from './connectors.service';

/** Requests per dock per hour; bounds what a leaked dock token can spend. */
const DOCK_REQUEST_LIMIT = 3000;
const API_TIMEOUT_MS = 60_000;
const MCP_TIMEOUT_MS = 10 * 60_000;
/** Tokens work only while the dock can run an agent. */
const LIVE_DOCK_STATES = new Set(['ready', 'idle', 'running']);
const PATH_RE = /^[A-Za-z0-9._~\-:/]*$/;
/** Only these client headers reach the vendor; credentials and proxy metadata never do. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];

export interface ConnectorGatewayRequest {
  kind: string;
  /** Everything after the kind: `api/...` or `mcp/...`. */
  path: string;
  query: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export interface GatewayUpstream {
  response: Response;
  target: 'api' | 'mcp';
}

export class ConnectorGatewayUnauthorizedException extends UnauthorizedException {
  constructor() {
    super({ code: 'invalid_connector_token', message: 'Invalid or expired connector token' });
  }
}

function badPath(): HttpException {
  return new HttpException({ code: 'validation_error', message: 'Unsupported gateway path' }, HttpStatus.BAD_REQUEST);
}

/** Resolves a gateway path to one fixed vendor URL, or null when it is not on the kind's allowlist. */
export function resolveUpstream(kind: ConnectorKind, path: string, query: string, host?: string | null): { url: string; target: 'api' | 'mcp' } | null {
  if (!PATH_RE.test(path) || path.split('/').some((s) => s === '..' || s === '.')) return null;
  const [target, ...rest] = path.split('/');
  const tail = rest.join('/');
  const spec = CONNECTOR_SPECS[kind];
  let url: string;
  if (target === 'api') {
    if (!spec.api.allow.test(tail)) return null;
    url = `${apiBase(kind, host)}/${tail}${query}`;
  } else if (target === 'mcp' && spec.mcp) {
    url = `${spec.mcp}${tail ? `/${tail}` : ''}${query}`;
  } else {
    return null;
  }
  // Defense in depth: the host can never differ from the allowlisted one.
  const base = new URL(target === 'api' ? apiBase(kind, host) : (spec.mcp as string));
  const parsed = new URL(url);
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) return null;
  return { url, target };
}

/**
 * Connector gateway: docks hold only a dock-scoped token; the workspace's real
 * credential is attached here and only for allowlisted vendor hosts and paths.
 */
@Injectable()
export class ConnectorGatewayService {
  private readonly fetchFn: typeof fetch;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectors: ConnectorsService,
    private readonly limits: RateLimitService,
    @Optional() options: { fetchFn?: typeof fetch } = {},
  ) {
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async forward(req: ConnectorGatewayRequest): Promise<GatewayUpstream> {
    const token = bearer(req.headers);
    if (!token) throw new ConnectorGatewayUnauthorizedException();
    const [dock] = await this.db.select().from(docks).where(eq(docks.connectorTokenHash, hashToken(token))).limit(1);
    if (!dock || !LIVE_DOCK_STATES.has(dock.state)) throw new ConnectorGatewayUnauthorizedException();
    if (!isConnectorKind(req.kind)) throw badPath();
    const kind = req.kind;
    if (!dock.connectors.includes(kind)) {
      throw new HttpException({ code: 'connector_not_enabled', message: `This dock was not created with ${kind}` }, HttpStatus.FORBIDDEN);
    }
    const resolved = resolveUpstream(kind, req.path, req.query);
    if (!resolved) {
      if (req.path.split('/')[0] === 'mcp') throw new NotFoundException({ code: 'connector_target_unsupported', message: `${kind} has no MCP endpoint` });
      throw badPath();
    }
    const hit = await this.limits.hit(`rl:connector-gw:${dock.id}`, DOCK_REQUEST_LIMIT, 3600);
    if (!hit.allowed) throw new HttpException({ code: 'rate_limited', message: 'Connector request budget exhausted' }, HttpStatus.TOO_MANY_REQUESTS);
    const cred = await this.connectors.accessFor(dock.workspaceId, kind);
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    Object.assign(headers, upstreamAuth(kind, resolved.target, cred));
    const upstream = resolveUpstream(kind, req.path, req.query, cred.host) ?? resolved;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length > 0;
    let response: Response;
    try {
      response = await this.fetchFn(upstream.url, {
        method: req.method,
        headers,
        body: hasBody ? new Uint8Array(req.body as Buffer) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(resolved.target === 'mcp' ? MCP_TIMEOUT_MS : API_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException({ code: 'connector_unreachable', message: `Could not reach ${kind}` });
    }
    // A redirect could leave the allowlist, so it is never followed or relayed.
    if (response.status >= 300 && response.status < 400) {
      throw new BadGatewayException({ code: 'connector_upstream_redirect', message: `${kind} answered with a redirect` });
    }
    return { response, target: resolved.target };
  }
}

function bearer(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const match = /^Bearer (.+)$/.exec(raw?.trim() ?? '');
  return match?.[1]?.trim() || null;
}
