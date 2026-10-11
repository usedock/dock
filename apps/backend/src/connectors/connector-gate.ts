import type { Connector } from '../database/schema';
import { apiBase, upstreamAuth, type ConnectorAccess } from './connector-kinds';

type Json = Record<string, any>;

/** An event is either admitted or refused; `say` is a short explanation posted back where the tool allows. */
export type Admission = { ok: true } | { ok: false; say?: string };

/** Fail closed and fast: Slack wants its ack within three seconds. */
const GATE_TIMEOUT_MS = 2500;

const deny = (say?: string): Admission => ({ ok: false, say });

/** Slack: the sender must be a full member of the connected team; guests, bots and Slack Connect users are refused. */
export async function admitSlack(fetchFn: typeof fetch, access: ConnectorAccess, connector: Connector, payload: Json): Promise<Admission> {
  const event: Json = payload.event ?? {};
  const user = String(event.user ?? '');
  const message = 'Dock only starts runs for full members of this Slack workspace.';
  if (!user || !connector.externalId) return deny();
  if (event.user_team && String(event.user_team) !== connector.externalId) return deny(message);
  let info: Json | null = null;
  try {
    const res = await fetchFn(`${apiBase('slack', access.host)}/users.info?user=${encodeURIComponent(user)}`, {
      headers: upstreamAuth('slack', 'api', access),
      redirect: 'manual',
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
    info = res.ok ? ((await res.json().catch(() => null)) as Json | null) : null;
  } catch {
    return deny();
  }
  const u: Json | undefined = info?.ok === true ? info.user : undefined;
  if (!u) return deny();
  const external = u.is_stranger === true || (u.team_id && String(u.team_id) !== connector.externalId);
  if (u.deleted || u.is_bot || u.is_app_user || u.is_restricted || u.is_ultra_restricted || external) return deny(message);
  return { ok: true };
}

/** Linear: the actor must be an active, non-guest member of the connected organization. */
export async function admitLinear(fetchFn: typeof fetch, access: ConnectorAccess, connector: Connector, payload: Json): Promise<Admission> {
  const actor: Json = payload.actor ?? {};
  const message = 'Dock only starts runs for members of this Linear organization, not guests.';
  if (String(actor.type ?? '').toLowerCase() !== 'user' || !actor.id) return deny();
  let json: Json | null = null;
  try {
    const res = await fetchFn(`${apiBase('linear', access.host)}/graphql`, {
      method: 'POST',
      headers: { ...upstreamAuth('linear', 'api', access), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query($id: String!) { user(id: $id) { id active guest organization { id } } }', variables: { id: String(actor.id) } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
    json = res.ok ? ((await res.json().catch(() => null)) as Json | null) : null;
  } catch {
    return deny();
  }
  const user: Json | undefined = json?.errors ? undefined : json?.data?.user;
  if (!user) return deny();
  if (!user.active || user.guest !== false || user.organization?.id !== connector.externalId) return deny(message);
  return { ok: true };
}

/** Figma: only the connector's allowlisted Figma user ids (default: the connecting admin). */
export function admitFigma(connector: Connector, payload: Json): Admission {
  const sender = payload.triggered_by?.id;
  if (sender !== undefined && connector.allowedUsers.includes(String(sender))) return { ok: true };
  return deny('Dock only answers approved users. An admin can add you to the Figma allowlist in Dock.');
}

/** Sentry: event text can come from end users of the monitored app, so runs start only after an admin opts in. */
export function admitSentry(connector: Connector): Admission {
  return connector.triggersEnabled ? { ok: true } : deny();
}
