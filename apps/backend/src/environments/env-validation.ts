import { BadRequestException } from '@nestjs/common';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_KEYS = 100;
export const MAX_ENV_BYTES = 65536;
export const MAX_ENV_KEY_LENGTH = 128;
export const MAX_SECRET_FILES = 20;
export const MAX_SECRET_FILE_BYTES = 262144;
export const MAX_SECRET_FILES_BYTES = 1048576;
export const MAX_SECRET_PATH_LENGTH = 256;
export const MAX_BRANCH_LENGTH = 128;
export const MAX_SETUP_SCRIPT_BYTES = 65536;
export const FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Names the driver injects itself; never accepted from callers. */
export const RESERVED_ENV_NAMES: Record<string, true> = { DOCK_ID: true, BOX_ID: true, ASCII_TOKEN: true };

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

/** Single variable name check: shape, length, and driver-reserved names. */
export function assertEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key) || key.length > MAX_ENV_KEY_LENGTH) {
    throw validationError(`env key ${key} must match [A-Za-z_][A-Za-z0-9_]* within 128 chars`);
  }
  assertNotReserved(key);
}

/** Driver-reserved names only; per-dock env keeps its looser shape rules. */
export function assertNotReserved(key: string): void {
  if (RESERVED_ENV_NAMES[key] === true || key.startsWith('DOCK_')) {
    throw validationError(`env key ${key} is reserved`);
  }
}

/** Whole-map check: count and serialized-size caps after per-key checks. */
export function assertEnvMap(vars: Record<string, string>): void {
  const entries = Object.entries(vars);
  if (entries.length > MAX_ENV_KEYS) throw validationError('env holds at most 100 variables');
  for (const [k, v] of entries) {
    assertEnvKey(k);
    if (typeof v !== 'string') throw validationError(`env ${k} must be a string`);
  }
  if (JSON.stringify(vars).length > MAX_ENV_BYTES) throw validationError('env totals at most 64KB');
}

/** Dotenv parse: KEY=value lines, blanks and # comments skipped, last wins. */
export function parseEnvContents(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) throw validationError(`env line ${trimmed.slice(0, 32)} is not KEY=value`);
    const key = trimmed.slice(0, eq).trim();
    assertEnvKey(key);
    out[key] = trimmed.slice(eq + 1);
  }
  assertEnvMap(out);
  return out;
}

/** Canonical dotenv form for reveal responses. */
export function serializeEnvContents(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
    .concat(Object.keys(vars).length ? '\n' : '');
}

/** Repo-relative file path check: no absolutes, no escapes, no control chars. */
export function assertSecretPath(path: string): void {
  if (!path || path.length > MAX_SECRET_PATH_LENGTH) {
    throw validationError('secret file path must be 1-256 chars');
  }
  if (path.startsWith('/') || path.includes('\\') || /[\0-\x1f\x7f]/.test(path)) {
    throw validationError(`secret file path ${path} must be relative and printable`);
  }
  if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw validationError(`secret file path ${path} must not escape /home/user`);
  }
  if (path.split('/')[0] === '.dock') {
    throw validationError(`secret file path ${path} is reserved for the platform`);
  }
}
