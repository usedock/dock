/** Longest reply sent to a vendor; an agent summary is asked to stay well under it. */
export const MAX_REPLY_CHARS = 2000;

const REDACTED = '[redacted]';

// Credential shapes the run's tools and providers use, plus Dock's own 256-bit hex tokens.
const PATTERNS: RegExp[] = [
  /\bsntry[us]_[A-Za-z0-9_-]{8,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{8,}/g,
  /\bfigd_[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bdock_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[0-9a-f]{40,}\b/gi,
];

/** Scrubs known secret values and common credential patterns, then caps the length. */
export function redactSecrets(text: string, secrets: readonly string[] = [], max = MAX_REPLY_CHARS): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out.length > max ? `${out.slice(0, max)}...` : out;
}
