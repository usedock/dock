import type { ConnectorKind, ConnectorReplyTarget } from '../database/schema';

/** What a vendor event asks Dock to do, already reduced to prompt text and a reply target. */
export interface ConnectorTrigger {
  kind: ConnectorKind;
  /** One active run per key, so a busy thread or issue does not fan out. */
  key: string;
  title: string;
  body: string;
  url: string | null;
  reply: ConnectorReplyTarget;
  /** Linear team id, Slack channel id, Sentry project slug or Figma file key; what a repository link is matched on. */
  scope?: string;
}

type Json = Record<string, any>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const scopeOf = (value: unknown): { scope?: string } => (typeof value === 'string' && value ? { scope: value } : {});

/** The label that opts a Linear issue in. */
export const LINEAR_LABEL = 'dock';

/** Linear issue assigned to the connected user, or newly labelled `dock`. */
export function linearTrigger(payload: Json, vendorUserId: string | null): ConnectorTrigger | null {
  if (payload.type !== 'Issue' || (payload.action !== 'create' && payload.action !== 'update')) return null;
  const data: Json = payload.data ?? {};
  const from: Json = payload.updatedFrom ?? {};
  const created = payload.action === 'create';
  const assigned = !!vendorUserId && data.assigneeId === vendorUserId && (created || 'assigneeId' in from);
  const labels: Json[] = Array.isArray(data.labels) ? data.labels : [];
  const label = labels.find((l) => str(l?.name).toLowerCase() === LINEAR_LABEL);
  const previous: unknown[] | null = Array.isArray(from.labelIds) ? from.labelIds : null;
  const labelled = !!label && (created || (previous !== null && !previous.includes(label.id)));
  if (!data.id || (!assigned && !labelled)) return null;
  return {
    kind: 'linear',
    key: `issue:${data.id}`,
    title: `${str(data.identifier)} ${str(data.title)}`.trim(),
    body: str(data.description),
    url: str(payload.url) || str(data.url) || null,
    reply: { issueId: String(data.id) },
    ...scopeOf(data.teamId ?? data.team?.id),
  };
}

/** Slack `app_mention`; replies stay in the mention's thread. */
export function slackTrigger(payload: Json): ConnectorTrigger | null {
  const event: Json = payload.event ?? {};
  if (payload.type !== 'event_callback' || event.type !== 'app_mention' || event.bot_id || !event.channel || !event.ts) return null;
  const threadTs = String(event.thread_ts ?? event.ts);
  return {
    kind: 'slack',
    key: `thread:${event.channel}:${threadTs}`,
    title: 'Slack mention',
    // The app's own mention is not part of the request.
    body: str(event.text).replace(/<@[A-Z0-9]+>/g, '').trim(),
    url: null,
    reply: { channel: String(event.channel), threadTs },
    scope: String(event.channel),
  };
}

/** Organization slug from an issue URL: `/organizations/<org>/...` (self-hosted, legacy) or an `<org>.sentry.io` style subdomain. */
export function sentryOrgFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const path = /^\/organizations\/([^/]+)\//.exec(parsed.pathname);
  if (path) return decodeURIComponent(path[1]);
  const sub = /^([a-z0-9][a-z0-9-]*)\.(?:[a-z]{2}\.)?sentry\.io$/i.exec(parsed.hostname);
  return sub && !['www', 'us', 'de'].includes(sub[1].toLowerCase()) ? sub[1] : undefined;
}

/** Sentry `issue.created` and `event_alert` webhooks, keyed by issue so both fire one run. */
export function sentryTrigger(resource: string | undefined, payload: Json): ConnectorTrigger | null {
  const data: Json = payload.data ?? {};
  if (resource === 'issue' && payload.action === 'created' && data.issue?.id) {
    const issue = data.issue;
    return {
      kind: 'sentry',
      key: `issue:${issue.id}`,
      title: str(issue.title) || 'Sentry issue',
      body: [str(issue.culprit) && `Culprit: ${issue.culprit}`, str(issue.level) && `Level: ${issue.level}`, str(issue.project?.slug) && `Project: ${issue.project.slug}`].filter(Boolean).join('\n'),
      url: str(issue.web_url) || str(issue.permalink) || null,
      reply: { issueId: String(issue.id), org: sentryOrgFromUrl(str(issue.web_url) || str(issue.permalink)) },
      ...scopeOf(issue.project?.slug),
    };
  }
  if (resource === 'event_alert' && payload.action === 'triggered' && data.event?.issue_id) {
    const event = data.event;
    return {
      kind: 'sentry',
      key: `issue:${event.issue_id}`,
      title: str(event.title) || 'Sentry alert',
      body: [str(data.triggered_rule) && `Alert rule: ${data.triggered_rule}`, str(event.culprit) && `Culprit: ${event.culprit}`].filter(Boolean).join('\n'),
      url: str(event.web_url) || null,
      reply: { issueId: String(event.issue_id), org: sentryOrgFromUrl(str(event.web_url)) },
      ...scopeOf(event.project_slug ?? data.project_slug),
    };
  }
  return null;
}

/** Figma `FILE_COMMENT` that mentions the connected user or writes @dock; who may start a run is decided by the caller. */
export function figmaTrigger(payload: Json, vendorUserId: string | null): ConnectorTrigger | null {
  if (payload.event_type !== 'FILE_COMMENT' || !payload.file_key || payload.comment_id === undefined) return null;
  const fragments: Json[] = Array.isArray(payload.comment) ? payload.comment : [];
  const text = fragments.map((f) => str(f?.text)).join('').trim();
  const mentions: Json[] = Array.isArray(payload.mentions) ? payload.mentions : [];
  const mentioned = (!!vendorUserId && mentions.some((m) => String(m?.id) === vendorUserId)) || /(^|\s)@dock\b/i.test(text);
  if (!mentioned) return null;
  // Replies attach to the thread's first comment.
  const root = String(payload.parent_id ?? payload.comment_id);
  return {
    kind: 'figma',
    key: `comment:${payload.file_key}:${root}`,
    title: `Figma comment on ${str(payload.file_name) || String(payload.file_key)}`,
    body: text,
    url: `https://www.figma.com/file/${payload.file_key}`,
    reply: { fileKey: String(payload.file_key), commentId: root },
    scope: String(payload.file_key),
  };
}
