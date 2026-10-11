// Resolves the bash the tests may spawn. On Windows a bare `bash` can be the WSL
// launcher (System32 or WindowsApps), and running it starts WSL, so it is never used.
const GIT_BASH_PATHS = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'];

export interface BashResolution { bash?: string; reason?: string }
export interface BashEnv { platform: string; env: Record<string, string | undefined>; exists: (p: string) => boolean }

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

export function isSafeWindowsBash(p: string): boolean {
  const n = norm(p);
  if (!/^[a-z]:\\/.test(n)) return false;
  if (/^[a-z]:\\windows\\(system32|sysnative|syswow64)\\/.test(n)) return false;
  return !n.split('\\').includes('windowsapps');
}

export function resolveBash({ platform, env, exists }: BashEnv): BashResolution {
  if (platform !== 'win32') return { bash: 'bash' };
  const configured = env.DOCK_TEST_BASH;
  if (configured) {
    if (!isSafeWindowsBash(configured)) {
      return { reason: `DOCK_TEST_BASH=${configured} is not an absolute path outside System32 and WindowsApps` };
    }
    return exists(configured) ? { bash: configured } : { reason: `DOCK_TEST_BASH=${configured} does not exist` };
  }
  const found = GIT_BASH_PATHS.find((p) => exists(p));
  return found ? { bash: found } : { reason: 'no Git Bash found; set DOCK_TEST_BASH (never the WSL bash)' };
}
