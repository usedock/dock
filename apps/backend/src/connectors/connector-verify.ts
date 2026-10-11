import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { CONNECTOR_SPECS, upstreamAuth, type ConnectorCredential, type ConnectorKind } from './connector-kinds';

/** Cheap vendor identity call; returns an account label or throws a typed error. */
export async function verifyCredential(fetchFn: typeof fetch, kind: ConnectorKind, cred: ConnectorCredential): Promise<string | null> {
  const base = CONNECTOR_SPECS[kind].api.base;
  const auth = upstreamAuth(kind, 'api', cred);
  const call: Record<ConnectorKind, [string, RequestInit]> = {
    figma: [`${base}/v1/me`, { headers: auth }],
    linear: [
      `${base}/graphql`,
      { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { name organization { name } } }' }) },
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
      return json.handle ?? json.email ?? null;
    case 'linear':
      if (json.errors || !json.data?.viewer) throw invalidToken();
      return json.data.viewer.organization?.name ?? json.data.viewer.name ?? null;
    case 'slack':
      if (json.ok !== true) throw invalidToken();
      return json.team ?? null;
    case 'sentry':
      return Array.isArray(json) ? (json[0]?.slug ?? null) : null;
  }
}

function invalidToken(): BadRequestException {
  return new BadRequestException({ code: 'connector_token_invalid', message: 'The tool rejected this token' });
}

function unreachable(): BadGatewayException {
  return new BadGatewayException({ code: 'connector_unreachable', message: 'Could not reach the tool to check the token' });
}
