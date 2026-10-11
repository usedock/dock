import { HttpException, HttpStatus, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { RateLimitService } from '../auth/rate-limit.service';
import { hashToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { connectorRuns, docks, githubRuns } from '../database/schema';
import { type ChatgptAccess, ChatgptNotConnectedException, ChatgptService } from '../chatgpt/chatgpt.service';
import { EnvironmentsService } from '../environments/environments.service';
import { LLM_UPSTREAMS, providerOf } from './runner';

/** Requests per run per hour; bounds what a leaked run token can spend. */
const RUN_REQUEST_LIMIT = 2000;
const LIVE_STATES = new Set(['provisioning', 'working']);
const CONNECTOR_LIVE_STATES = new Set(['pending', 'working']);

/** What the gateway needs of a run to pick the org's provider key. */
interface RunScope {
  organizationId: string | null;
  agent: string;
}
/** Dock tokens work only while the dock can run an agent. */
const LIVE_DOCK_STATES = new Set(['ready', 'idle', 'running']);
const PATH_RE = /^[A-Za-z0-9._~\-/]+$/;
/** Codex backend routes agents need (inference and the model list); nothing else of the user's account is reachable. */
const CHATGPT_PATHS = new Set(['responses', 'models']);
/** Client headers never forwarded upstream: credentials, hop-by-hop, and proxy metadata. */
const DROPPED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'cookie',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'chatgpt-account-id',
  'x-openai-internal-codex-residency',
]);

export interface GatewayRequest {
  provider: string;
  path: string;
  query: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export class GatewayUnauthorizedException extends UnauthorizedException {
  constructor() {
    super({ code: 'invalid_gateway_token', message: 'Invalid or expired gateway token' });
  }
}

/**
 * Vault Gateway for run LLM traffic: guests hold only a run-scoped token,
 * the provider key stays in the control plane and is attached here. Tokens
 * die with the run and only reach the run's own provider.
 */
@Injectable()
export class LlmGatewayService {
  private readonly fetchFn: typeof fetch;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvironmentsService,
    private readonly limits: RateLimitService,
    @Optional() options: { fetchFn?: typeof fetch } = {},
    @Optional() private readonly chatgpt?: ChatgptService,
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async forward(req: GatewayRequest): Promise<Response> {
    const token = runToken(req.headers);
    if (!token) throw new GatewayUnauthorizedException();
    const caller = await this.caller(hashToken(token), req.provider);
    const upstream = LLM_UPSTREAMS[req.provider];
    if (!upstream || !PATH_RE.test(req.path) || req.path.split('/').includes('..')) {
      throw new HttpException({ code: 'validation_error', message: 'Unsupported gateway path' }, HttpStatus.BAD_REQUEST);
    }
    const hit = await this.limits.hit(`rl:llm-gw:${caller.rateKey}`, RUN_REQUEST_LIMIT, 3600);
    if (!hit.allowed) throw new HttpException({ code: 'rate_limited', message: 'Run LLM budget exhausted' }, HttpStatus.TOO_MANY_REQUESTS);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-forwarded-')) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (req.provider === 'chatgpt') {
      Object.assign(headers, await this.chatgptHeaders(caller.llmUserId, req.path));
    } else {
      const run = caller.run as RunScope;
      const orgId = run.organizationId;
      const bundle = orgId ? await this.envs.resolveBundle(orgId, undefined, { agents: [run.agent] }).catch(() => null) : null;
      const key = bundle?.vars[upstream.key];
      if (!key) throw providerNotConfigured();
      if (upstream.auth === 'x-api-key') headers['x-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length > 0;
    return this.fetchFn(`${upstream.base}/${req.path}${req.query}`, {
      method: req.method,
      headers,
      body: hasBody ? new Uint8Array(req.body as Buffer) : undefined,
    });
  }

  /**
   * A live run's token reaches its own model provider; a dock token reaches
   * only the ChatGPT route, as the dock's creator. Docks get org provider
   * keys as env vars instead, so they never need the gateway for those.
   */
  private async caller(tokenHash: string, provider: string): Promise<{ rateKey: string; llmUserId: string | null; run: RunScope | null }> {
    const [run] = await this.db.select().from(githubRuns).where(eq(githubRuns.gatewayTokenHash, tokenHash)).limit(1);
    if (run) {
      if (!LIVE_STATES.has(run.state) || !run.model || providerOf(run.model) !== provider) throw new GatewayUnauthorizedException();
      return { rateKey: run.id, llmUserId: run.llmUserId, run };
    }
    const [connectorRun] = await this.db.select().from(connectorRuns).where(eq(connectorRuns.gatewayTokenHash, tokenHash)).limit(1);
    if (connectorRun) {
      // Connector runs never use a ChatGPT sign-in; the token dies when the run settles.
      if (!CONNECTOR_LIVE_STATES.has(connectorRun.state) || !connectorRun.model || providerOf(connectorRun.model) !== provider || provider === 'chatgpt') throw new GatewayUnauthorizedException();
      return { rateKey: connectorRun.id, llmUserId: null, run: connectorRun };
    }
    if (provider !== 'chatgpt') throw new GatewayUnauthorizedException();
    const [dock] = await this.db.select().from(docks).where(eq(docks.llmTokenHash, tokenHash)).limit(1);
    if (!dock || !LIVE_DOCK_STATES.has(dock.state) || !dock.createdBy) throw new GatewayUnauthorizedException();
    return { rateKey: `dock:${dock.id}`, llmUserId: dock.createdBy, run: null };
  }

  /** The run's ChatGPT user's live token plus the account routing Codex expects. */
  private async chatgptHeaders(userId: string | null, path: string): Promise<Record<string, string>> {
    if (!CHATGPT_PATHS.has(path)) {
      throw new HttpException({ code: 'validation_error', message: 'Unsupported gateway path' }, HttpStatus.BAD_REQUEST);
    }
    if (!userId || !this.chatgpt) throw providerNotConfigured();
    let access: ChatgptAccess;
    try {
      access = await this.chatgpt.accessFor(userId);
    } catch (err) {
      if (err instanceof ChatgptNotConnectedException) throw providerNotConfigured();
      throw err;
    }
    return {
      authorization: `Bearer ${access.access}`,
      ...(access.accountId ? { 'chatgpt-account-id': access.accountId } : {}),
      ...(access.residency ? { 'x-openai-internal-codex-residency': access.residency } : {}),
    };
  }
}

function providerNotConfigured(): HttpException {
  return new HttpException({ code: 'provider_not_configured', message: 'Provider key unavailable' }, HttpStatus.SERVICE_UNAVAILABLE);
}

/** Run token from `Authorization: Bearer` (OpenAI-style) or `x-api-key` (Anthropic-style). */
function runToken(headers: Record<string, string | string[] | undefined>): string | null {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const bearer = /^Bearer (.+)$/.exec(first(headers.authorization)?.trim() ?? '');
  const token = bearer?.[1] ?? first(headers['x-api-key']);
  return token?.trim() || null;
}
