const BASE = 'http://dock.invalid';

/**
 * Post-login destination from a `next` query value; only same-origin paths survive.
 * Parsed with URL because browsers strip tab/CR/LF, so `/\t/evil.com` would otherwise
 * become `//evil.com`. Rejects: `//evil.com`, `/\evil.com`, `https://evil`, `javascript:`,
 * and any control character.
 */
export function safeNext(value: string | string[] | undefined | null): string {
  const raw = Array.isArray(value) ? value[0] : value;
  // eslint-disable-next-line no-control-regex
  if (!raw || !raw.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(raw)) return '/';
  try {
    const url = new URL(raw, BASE);
    if (url.origin !== BASE) return '/';
    const out = url.pathname + url.search + url.hash;
    return out.startsWith('//') ? '/' : out;
  } catch {
    return '/';
  }
}

/** Appends the destination to an auth link so sign-in and sign-up return to it. */
export function withNext(path: string, next: string): string {
  return next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
}
