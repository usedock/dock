import type { ConnectorKind, ConnectorReplyTarget } from '../database/schema';
import { redactSecrets } from './connector-redact';
import { apiBase, upstreamAuth, type ConnectorAccess } from './connector-kinds';

const REPLY_TIMEOUT_MS = 15_000;

async function call(fetchFn: typeof fetch, kind: ConnectorKind, access: ConnectorAccess, path: string, body: unknown): Promise<any> {
  const res = await fetchFn(`${apiBase(kind, access.host)}/${path}`, {
    method: 'POST',
    headers: { ...upstreamAuth(kind, 'api', access), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${kind} reply failed with ${res.status}`);
  return json;
}

async function linear(fetchFn: typeof fetch, access: ConnectorAccess, query: string, variables: Record<string, unknown>): Promise<any> {
  const json = await call(fetchFn, 'linear', access, 'graphql', { query, variables });
  if (json?.errors?.length) throw new Error('linear reply failed');
  return json?.data;
}

/** Moves a Linear issue to the first workflow state of its team with this type. */
export async function linearSetState(fetchFn: typeof fetch, access: ConnectorAccess, issueId: string, type: 'started' | 'completed'): Promise<void> {
  const found = await linear(fetchFn, access, 'query($id: String!) { issue(id: $id) { team { states { nodes { id type position } } } } }', { id: issueId });
  const nodes: Array<{ id: string; type: string; position: number }> = found?.issue?.team?.states?.nodes ?? [];
  const state = nodes.filter((n) => n.type === type).sort((a, b) => a.position - b.position)[0];
  if (!state) return;
  await linear(fetchFn, access, 'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }', { id: issueId, stateId: state.id });
}

/** Posts text back where the event came from: a Linear comment, Slack thread message, Sentry issue note or Figma comment reply. */
export async function postReply(fetchFn: typeof fetch, kind: ConnectorKind, access: ConnectorAccess, target: ConnectorReplyTarget, text: string): Promise<void> {
  // Every reply passes here: secrets are scrubbed and the length capped, and no reply can mention @dock and re-trigger itself.
  const body = redactSecrets(text).replace(/@dock/gi, 'dock');
  switch (kind) {
    case 'linear':
      await linear(fetchFn, access, 'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }', { issueId: target.issueId, body });
      return;
    case 'slack': {
      const json = await call(fetchFn, 'slack', access, 'chat.postMessage', { channel: target.channel, thread_ts: target.threadTs, text: body });
      if (json?.ok !== true) throw new Error('slack reply failed');
      return;
    }
    case 'sentry':
      // The unscoped issue comments route is deprecated; the organization route needs the slug.
      if (!target.org) throw new Error('sentry organization unknown');
      await call(fetchFn, 'sentry', access, `0/organizations/${encodeURIComponent(target.org)}/issues/${encodeURIComponent(target.issueId ?? '')}/comments/`, { text: body });
      return;
    case 'figma':
      await call(fetchFn, 'figma', access, `v1/files/${encodeURIComponent(target.fileKey ?? '')}/comments`, { message: body, comment_id: target.commentId });
  }
}
