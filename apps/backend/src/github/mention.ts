const MENTION_RE = /@dock\b/i;
const FENCED_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_RE = /`[^`\n]*`/g;
const BASE_BRANCH_RE = /@dock[^\n]*?\bbase\s*[:=]\s*([A-Za-z0-9_./-]+)/i;
const EXECUTION_TARGET_RE = /@dock(?:\s+(fast|dock)\b|[^\n]*\b(?:target|execution(?:-target)?|mode)\s*[:=]\s*([A-Za-z0-9_-]+))/i;

/** Strips fenced and inline code so `@dock` in samples never triggers a run. */
export function stripCodeBlocks(body: string): string {
  return body.replace(FENCED_RE, '').replace(INLINE_RE, '');
}

/** Case-insensitive `@dock` word match outside code blocks. */
export function hasDockMention(body: string): boolean {
  return MENTION_RE.test(stripCodeBlocks(body));
}

/** Optional `base: <branch>` override on the mention line; null means the default branch. */
export function parseBaseBranch(body: string): string | null {
  const match = BASE_BRANCH_RE.exec(stripCodeBlocks(body));
  return match ? match[1] : null;
}

/** Optional explicit execution target; null preserves the persistent Dock default. */
export function parseExecutionTarget(body: string): string | null {
  const match = EXECUTION_TARGET_RE.exec(stripCodeBlocks(body));
  return match ? (match[1] ?? match[2]).toLowerCase() : null;
}

/** Capability hints on the `@dock` line only, e.g. `@dock fast needs ssh, persistent`. */
export function parseRunCapabilities(body: string): Record<string, boolean> {
  const stripped = stripCodeBlocks(body);
  const line = /@dock[^\n]*/i.exec(stripped)?.[0] ?? '';
  const caps: Record<string, boolean> = {};
  if (/\bssh\b/i.test(line) || /\btakeover\b/i.test(line)) caps.sshTakeover = true;
  if (/\bpersistent\b/i.test(line) || /\bpersistence\b/i.test(line)) caps.persistentState = true;
  if (/\bdocker\b/i.test(line)) caps.docker = true;
  if (/\bsystemd\b/i.test(line)) caps.systemd = true;
  if (/\bbrowser\b/i.test(line)) caps.browser = true;
  return caps;
}

/** GitHub also emits `issue_comment` for PR conversations; v1 runs on issues only. */
export function isIssueTarget(payload: {
  issue?: ({ pull_request?: unknown } & Record<string, unknown>) | null;
  pull_request?: unknown;
}): boolean {
  if (!payload.issue) return false;
  if (payload.pull_request) return false;
  return payload.issue.pull_request === undefined || payload.issue.pull_request === null;
}

/** The App's own comments (`<slug>[bot]`) must never retrigger a run. */
export function isAppSender(senderLogin: string | undefined, appSlug: string): boolean {
  return senderLogin === `${appSlug}[bot]`;
}
