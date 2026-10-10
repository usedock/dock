import type { ErrorEvent } from '@sentry/nestjs';

/** Raw env slice Sentry reads before Nest boots; ConfigService is unavailable there. */
export interface SentryPreBootEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  NODE_ENV?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string | number;
  SENTRY_ENABLED?: string;
}

export const SENTRY_FILTERED = '[Filtered]';

// Fail-closed denylist: any key containing one of these has its value scrubbed.
const SENSITIVE_KEY_PATTERN =
  /password|passwd|pwd|secret|token|api[-_]?key|auth|cookie|session|credential|private[-_]?key|email/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Tolerant gate: true only with a set, well-formed DSN that is not explicitly disabled. Never throws. */
export function shouldEnableSentry(env: SentryPreBootEnv): boolean {
  try {
    if (String(env.SENTRY_ENABLED ?? 'true').toLowerCase() === 'false') return false;
    const dsn = (env.SENTRY_DSN ?? '').trim();
    if (!dsn) return false;
    const url = new URL(dsn);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Deployment label for every event; falls back through NODE_ENV to development. */
export function resolveSentryEnvironment(env: SentryPreBootEnv): string {
  return env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development';
}

/** Sampling rate clamped to [0, 1]; unparseable input disables tracing. Never throws. */
export function resolveTracesSampleRate(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? SENTRY_FILTERED : scrubValue(entry);
    }
    return out;
  }
  return value;
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url.split('?')[0];
  }
}

/**
 * Last-chance PII scrub before an event leaves the process. Keeps the route
 * and user id; drops emails, credentials, tokens, cookies, auth headers, and
 * query strings. Mutates and returns the event (SDK convention).
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const userId = (event.user as { id?: unknown } | undefined)?.id;
  event.user = userId === undefined ? undefined : { id: String(userId) };
  const request = event.request;
  if (request) {
    if (typeof request.url === 'string') request.url = stripQuery(request.url);
    delete request.query_string;
    delete request.cookies;
    if (request.headers && typeof request.headers === 'object') {
      const headers = request.headers as Record<string, unknown>;
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'cookie' || lower === 'set-cookie' || lower === 'authorization') {
          delete headers[key];
        } else if (isSensitiveKey(key)) {
          headers[key] = SENTRY_FILTERED;
        }
      }
    }
    if (request.data !== undefined) {
      request.data = scrubValue(request.data) as typeof request.data;
    }
  }
  return event;
}
