import { CONNECTOR_KINDS, type ConnectorKind } from '../database/schema';

export { CONNECTOR_KINDS };
export type { ConnectorKind };

export function isConnectorKind(value: string): value is ConnectorKind {
  return (CONNECTOR_KINDS as readonly string[]).includes(value);
}

export interface ConnectorSpec {
  oauth: {
    authorizeUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    scopes: string[];
    scopeSeparator: string;
    pkce: boolean;
    /** Client credentials as HTTP Basic instead of body fields. */
    basicAuth: boolean;
  };
  /** Fixed upstream the gateway's `api` target maps onto; `allow` filters the remaining path. */
  api: { base: string; allow: RegExp };
  /** Official MCP endpoint (streamable HTTP) behind the gateway's `mcp` target. */
  mcp?: string;
}

/** Vendor endpoints and the only hosts and paths the gateway may reach per kind. */
export const CONNECTOR_SPECS: Record<ConnectorKind, ConnectorSpec> = {
  figma: {
    oauth: {
      authorizeUrl: 'https://www.figma.com/oauth',
      tokenUrl: 'https://api.figma.com/v1/oauth/token',
      refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
      scopes: ['current_user:read', 'file_content:read', 'file_comments:read', 'file_comments:write'],
      scopeSeparator: ',',
      pkce: true,
      basicAuth: true,
    },
    // No MCP target: mcp.figma.com admits only OAuth clients from Figma's MCP catalog, not tokens or ordinary OAuth apps.
    api: { base: 'https://api.figma.com', allow: /^v[12]\// },
  },
  linear: {
    oauth: {
      authorizeUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: ['read', 'write'],
      scopeSeparator: ',',
      pkce: true,
      basicAuth: false,
    },
    api: { base: 'https://api.linear.app', allow: /^graphql$/ },
    mcp: 'https://mcp.linear.app/mcp',
  },
  slack: {
    oauth: {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['channels:read', 'channels:history', 'chat:write', 'users:read', 'app_mentions:read'],
      scopeSeparator: ',',
      pkce: false,
      basicAuth: false,
    },
    api: { base: 'https://slack.com/api', allow: /^[A-Za-z0-9.]+$/ },
  },
  sentry: {
    oauth: {
      authorizeUrl: 'https://sentry.io/oauth/authorize/',
      tokenUrl: 'https://sentry.io/oauth/token/',
      scopes: ['org:read', 'project:read', 'event:read', 'event:write'],
      scopeSeparator: ' ',
      pkce: false,
      basicAuth: false,
    },
    api: { base: 'https://sentry.io/api', allow: /^0\// },
    mcp: 'https://mcp.sentry.dev/mcp',
  },
};

/** Sentry API base for a connector's region or self-hosted origin; `host` is an already validated origin. */
export function apiBase(kind: ConnectorKind, host?: string | null): string {
  if (kind === 'sentry' && host) return `${host}/api`;
  return CONNECTOR_SPECS[kind].api.base;
}

/** What a connector's sealed credential holds. */
export interface ConnectorCredential {
  type: 'token' | 'oauth';
  access: string;
  refresh?: string;
  /** Epoch ms; absent for tokens that do not expire. */
  expiresAt?: number;
}

/** A credential plus the non-secret row fields calls need. */
export type ConnectorAccess = ConnectorCredential & { host?: string | null };

/** Authorization headers for one upstream call; personal tokens use each vendor's own scheme on its API host. */
export function upstreamAuth(kind: ConnectorKind, target: 'api' | 'mcp', cred: ConnectorCredential): Record<string, string> {
  if (cred.type === 'token' && target === 'api') {
    if (kind === 'figma') return { 'x-figma-token': cred.access };
    if (kind === 'linear') return { authorization: cred.access };
  }
  // Sentry's MCP server reserves Bearer for its own OAuth tokens; upstream Sentry tokens use Sentry-Bearer.
  if (kind === 'sentry' && target === 'mcp') return { authorization: `Sentry-Bearer ${cred.access}` };
  return { authorization: `Bearer ${cred.access}` };
}

/** Per-kind env var stem, e.g. FIGMA for FIGMA_CLIENT_ID. */
export function envStem(kind: ConnectorKind): string {
  return kind.toUpperCase();
}
