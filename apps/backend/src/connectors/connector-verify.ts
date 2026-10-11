import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { apiBase, upstreamAuth, type ConnectorCredential, type ConnectorKind } from './connector-kinds';

/** What a vendor identity call tells us: a label, the id inbound webhooks route by and the connected vendor user. */
export interface VerifiedIdentity {
  label: string | null;
  externalId: string | null;
  userId: string | null;
}

/** Cheap vendor identity call; returns who the credential is or throws a typed error. */
export async function verifyCredential(fetchFn: typeof fetch, kind: ConnectorKind, cred: ConnectorCredential, host?: string | null): Promise<VerifiedIdentity> {
  const base = apiBase(kind, host);
  const auth = upstreamAuth(kind, 'api', cred);
  const call: Record<ConnectorKind, [string, RequestInit]> = {
    figma: [`${base}/v1/me`, { headers: auth }],
    linear: [
      `${base}/graphql`,
      { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { id name organization { id name } } }' }) },
    ],
    slack: [`${base}/auth.test`, { method: 'POST', headers: auth }],
    sentry: [`${base}/0/organizations/`, { headers: auth }],
  };
  const [url, init] = call[kind];
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw unreachable();
  }
  if (res.status === 401 || res.status === 403) throw invalidToken();
  if (!res.ok) throw unreachable();
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!json) throw unreachable();
  switch (kind) {
    case 'figma':
      return { label: json.handle ?? json.email ?? null, externalId: null, userId: json.id ? String(json.id) : null };
    case 'linear': {
      const viewer = json.data?.viewer;
      if (json.errors || !viewer) throw invalidToken();
      return { label: viewer.organization?.name ?? viewer.name ?? null, externalId: viewer.organization?.id ?? null, userId: viewer.id ?? null };
    }
    case 'slack':
      if (json.ok !== true) throw invalidToken();
      return { label: json.team ?? null, externalId: json.team_id ?? null, userId: json.user_id ?? null };
    case 'sentry':
      return { label: Array.isArray(json) ? (json[0]?.slug ?? null) : null, externalId: null, userId: null };
  }
}

function invalidToken(): BadRequestException {
  return new BadRequestException({ code: 'connector_token_invalid', message: 'The tool rejected this token' });
}

function unreachable(): BadGatewayException {
  return new BadGatewayException({ code: 'connector_unreachable', message: 'Could not reach the tool to check the token' });
}
