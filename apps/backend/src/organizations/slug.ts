import { randomBytes } from 'crypto';

/** Global org slugs and per-org workspace slugs share this shape. */
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/;

/** Lowercases, swaps runs of other chars for '-', trims edge dashes. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Short random tail appended when a derived slug collides. */
export function randomSuffix(): string {
  return randomBytes(4).toString('hex').slice(0, 6);
}

/** Derives a valid slug from a name, padding stubs shorter than 3 chars. */
export function candidateSlug(name: string): string {
  const base = slugify(name).slice(0, 48) || 'org';
  if (SLUG_RE.test(base)) return base;
  return `${base}-org`;
}

/** Derives the personal-org slug from an email local part. */
export function personalSlug(email: string): string {
  const base = slugify(email.split('@')[0] ?? '').slice(0, 48) || 'org';
  return `${base}-${randomSuffix()}`;
}
