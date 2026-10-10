import type { EnvRepo } from '../database/schema';
import { ENV_KEY_RE } from './env-validation';

/** Guest exec passes the script as one argv string; Linux caps those at 128KB. */
export const APPLY_SCRIPT_MAX_BYTES = 100_000;
const CHUNK_CHARS = 65_536;
const ENV_FILE = '.dock/env.sh';
const MANIFEST_FILE = '.dock/files';
const SETUP_DIR = '.dock/setup';
const SETUP_LOG = '.dock/setup.log';
/** First line is running, done, or the space-separated failed steps. */
export const SETUP_STATUS_FILE = '.dock/setup.status';
const RC_HOOK = 'if [ -f "$HOME/.dock/env.sh" ]; then . "$HOME/.dock/env.sh"; fi';

export interface ApplyBundle {
  vars: Record<string, string>;
  files: { path: string; contents: string }[];
  repos: EnvRepo[];
  /** Per-dock setup script from create; runs after the repo clones. */
  setupScript?: string | null;
}

/** POSIX single-quote escaping for one shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function homePath(relative: string): string {
  return `"$HOME"/${shellQuote(relative)}`;
}

/** Chunked base64 write: partial file, then an atomic decode-and-rename. */
function writeFileLines(relative: string, contents: string, mode: string): string[] {
  const dest = homePath(relative);
  const part = homePath(`${relative}.dock-part`);
  const encoded = Buffer.from(contents, 'utf8').toString('base64');
  const lines = [`mkdir -p -- "$(dirname -- ${dest})"`, `: > ${part}`];
  for (let i = 0; i < encoded.length; i += CHUNK_CHARS) {
    lines.push(`printf '%s' '${encoded.slice(i, i + CHUNK_CHARS)}' >> ${part}`);
  }
  lines.push(`base64 -d ${part} > ${dest}.dock-tmp && rm -f -- ${part} && chmod ${mode} ${dest}.dock-tmp && mv -f -- ${dest}.dock-tmp ${dest}`);
  return lines;
}

/** Folder a repo clones into: the repository name, never owner/name. */
export function repoFolder(repo: EnvRepo): string {
  return repo.fullName.split('/')[1];
}

function cloneUrl(repo: EnvRepo): string {
  return repo.provider === 'gitlab' ? `https://gitlab.com/${repo.fullName}.git` : `https://github.com/${repo.fullName}.git`;
}

/** Exec-env name carrying a platform-minted clone token for one repo; never written to disk. */
export function cloneTokenVar(repo: EnvRepo): string {
  return `DOCK_GIT_TOKEN_${repo.id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/** Background clone; tokens authenticate without landing in .git/config. Platform token first, then env vars. */
function cloneLines(repo: EnvRepo): string[] {
  const folder = repoFolder(repo);
  const dest = homePath(folder);
  const tmp = homePath(`.dock/clone-${repo.id}`);
  const auth =
    repo.provider === 'gitlab'
      ? 'tok="${GITLAB_TOKEN:-}"; user=oauth2'
      : `tok="\${${cloneTokenVar(repo)}:-\${GH_TOKEN:-\${GITHUB_TOKEN:-}}}"; user=x-access-token`;
  const branch = repo.baseBranch ? ` --branch ${shellQuote(repo.baseBranch)}` : '';
  const lines = [
    `if [ ! -d ${dest}/.git ]; then`,
    `  ${auth}; hdr=""; if [ -n "$tok" ]; then hdr="Authorization: Basic $(printf '%s:%s' "$user" "$tok" | base64 -w0)"; fi`,
    `  rm -rf -- ${tmp}`,
    // Secret files may already sit inside the folder; they win over tracked files.
    `  if git -c "http.extraHeader=$hdr" clone --quiet${branch} ${shellQuote(cloneUrl(repo))} ${tmp} && { [ ! -d ${dest} ] || { cp -a ${dest}/. ${tmp}/ && rm -rf -- ${dest}; }; } && mv -- ${tmp} ${dest}; then`,
  ];
  if (repo.setupScript !== null) {
    lines.push(`    (cd ${dest} && bash -l ${homePath(`${SETUP_DIR}/${repo.id}.sh`)}) || { echo "setup failed: ${folder}"; fail="$fail setup:${folder}"; }`);
  } else {
    lines.push('    :');
  }
  lines.push(`  else echo "clone failed: ${repo.fullName}"; fail="$fail clone:${folder}"; fi`, 'fi');
  return lines;
}

/** Packs independent lines into scripts that each fit one guest exec argv. */
function pack(lines: string[]): string[] {
  const header = 'set -eu\numask 077\n';
  const scripts: string[] = [];
  let current = header;
  for (const line of lines) {
    if (current !== header && Buffer.byteLength(current + line, 'utf8') + 1 > APPLY_SCRIPT_MAX_BYTES) {
      scripts.push(current);
      current = header;
    }
    current += `${line}\n`;
  }
  scripts.push(current);
  return scripts;
}

/**
 * Guest scripts that make the disk match one environment bundle: env file
 * sourced by login and interactive shells, secret files (files dropped from
 * the bundle are deleted), then repo clones and setup scripts in the
 * background so ready never waits on them. `background` says whether
 * setup.status will settle later.
 */
export function buildApplyScripts(bundle: ApplyBundle): { scripts: string[]; background: boolean } {
  // Per-dock env allows names a shell cannot export; those are skipped.
  const envFile = Object.entries(bundle.vars)
    .filter(([key]) => ENV_KEY_RE.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join('');
  const paths = bundle.files.map((f) => f.path);
  const lines: string[] = [
    ...writeFileLines(ENV_FILE, envFile, '600'),
    `for rc in "$HOME/.bashrc" "$HOME/.profile"; do grep -qxF ${shellQuote(RC_HOOK)} "$rc" 2>/dev/null || printf '%s\\n' ${shellQuote(RC_HOOK)} >> "$rc"; done`,
    `if [ -f ${homePath(MANIFEST_FILE)} ]; then printf '%s\\n' ${paths.map(shellQuote).join(' ')} | grep -vxF -f - ${homePath(MANIFEST_FILE)} | while IFS= read -r p; do rm -f -- "$HOME/$p"; done; fi`,
  ];
  for (const file of bundle.files) lines.push(...writeFileLines(file.path, file.contents, '600'));
  lines.push(...writeFileLines(MANIFEST_FILE, paths.map((p) => `${p}\n`).join(''), '600'));

  // Clones and setup output are ordinary files, not secrets.
  const background: string[] = ['umask 022', '. "$HOME/.dock/env.sh"', 'export GIT_TERMINAL_PROMPT=0', 'fail=""'];
  for (const repo of bundle.repos) {
    if (repo.setupScript !== null) lines.push(...writeFileLines(`${SETUP_DIR}/${repo.id}.sh`, repo.setupScript, '700'));
    background.push(...cloneLines(repo));
  }
  if (bundle.setupScript) {
    lines.push(...writeFileLines(`${SETUP_DIR}/dock.sh`, bundle.setupScript, '700'));
    background.push(`(cd "$HOME" && bash -l ${homePath(`${SETUP_DIR}/dock.sh`)}) || { echo "dock setup failed"; fail="$fail setup:dock"; }`);
  }
  const status = homePath(SETUP_STATUS_FILE);
  const hasBackground = background.length > 4;
  if (hasBackground) {
    background.push(`printf '%s\n' "\${fail:-done}" > ${status}.tmp && mv -f -- ${status}.tmp ${status}`);
    const runner = `${SETUP_DIR}/run.sh`;
    lines.push(...writeFileLines(runner, `${background.join('\n')}\n`, '700'));
    lines.push(`printf 'running\n' > ${status}`);
    lines.push(`nohup setsid bash ${homePath(runner)} >> ${homePath(SETUP_LOG)} 2>&1 < /dev/null &`);
  } else {
    lines.push(`printf 'done\n' > ${status}`);
  }
  return { scripts: pack(lines), background: hasBackground };
}
