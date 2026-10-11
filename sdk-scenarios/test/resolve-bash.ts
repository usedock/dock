// Resolves the bash the tests may spawn. On Windows a bare `bash` can be the WSL
// launcher (System32 or WindowsApps), and running it starts WSL, so it is never used.
import { win32 } from 'node:path';

const GIT_BASH_PATHS = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'];
const SCOOP_SUFFIXES = ['\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe', '\\scoop\\apps\\git\\current\\bin\\bash.exe'];

type Env = Record<string, string | undefined>;
export interface BashResolution { bash?: string; env?: Env; reason?: string }
export interface BashEnv { platform: string; env: Env; exists: (p: string) => boolean }

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

export function isSafeWindowsBash(p: string): boolean {
  const n = norm(p);
  if (!/^[a-z]:\\/.test(n)) return false;
  if (/\\windows\\(system32|sysnative|syswow64)\\/.test(n)) return false;
  return !n.split('\\').includes('windowsapps');
}

export function resolveBash({ platform, env, exists }: BashEnv): BashResolution {
  if (platform !== 'win32') return { bash: 'bash', env };
  const configured = env.DOCK_TEST_BASH;
  let bash: string | undefined;
  if (configured) {
    if (!isSafeWindowsBash(configured)) {
      return { reason: `DOCK_TEST_BASH=${configured} is not an absolute path outside System32, SysWOW64, Sysnative and WindowsApps` };
    }
    if (!exists(configured)) return { reason: `DOCK_TEST_BASH=${configured} does not exist` };
    bash = configured;
  } else {
    const profile = env.USERPROFILE;
    const candidates = [...GIT_BASH_PATHS, ...(profile ? SCOOP_SUFFIXES.map((s) => profile + s) : [])];
    bash = candidates.find((p) => exists(p));
    if (!bash) return { reason: 'no Git Bash found; set DOCK_TEST_BASH (never the WSL bash)' };
  }
  // Git's usr\bin first so find and base64 are the GNU tools, not System32\find.exe.
  const dir = win32.dirname(bash);
  const usrBin = win32.resolve(dir, '..', 'usr', 'bin');
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const path = [...new Set([usrBin, dir]), env[pathKey]].filter(Boolean).join(win32.delimiter);
  return { bash, env: { ...env, [pathKey]: path } };
}
