import { describe, expect, it } from 'vitest';
import { resolveBash } from './resolve-bash';

const GIT = 'C:\\Program Files\\Git\\bin\\bash.exe';
const GIT_USR = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
const win = (env: Record<string, string>, present: string[]) =>
  resolveBash({ platform: 'win32', env, exists: (p) => present.includes(p) });

describe('resolveBash', () => {
  it('uses bash from PATH off Windows', () => {
    expect(resolveBash({ platform: 'linux', env: {}, exists: () => false })).toEqual({ bash: 'bash' });
    expect(resolveBash({ platform: 'darwin', env: {}, exists: () => false })).toEqual({ bash: 'bash' });
  });

  it('prefers Git Bash bin, then usr/bin, on Windows', () => {
    expect(win({}, [GIT, GIT_USR]).bash).toBe(GIT);
    expect(win({}, [GIT_USR]).bash).toBe(GIT_USR);
  });

  it('skips with a reason, never bare bash, when nothing is found', () => {
    const r = win({}, []);
    expect(r.bash).toBeUndefined();
    expect(r.reason).toMatch(/DOCK_TEST_BASH/);
  });

  it('accepts a safe DOCK_TEST_BASH', () => {
    const p = 'D:\\tools\\git\\bin\\bash.exe';
    expect(win({ DOCK_TEST_BASH: p }, [p]).bash).toBe(p);
  });

  it.each([
    'C:\\Windows\\System32\\bash.exe',
    'c:/windows/system32/bash.exe',
    'C:\\WINDOWS\\SYSTEM32\\bash.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    'D:\\x\\windowsapps\\bash.exe',
    'bash',
    'bash.exe',
    '..\\bash.exe',
  ])('rejects unsafe DOCK_TEST_BASH %s without falling back to PATH', (p) => {
    const r = win({ DOCK_TEST_BASH: p }, [p, GIT]);
    expect(r.bash).toBeUndefined();
    expect(r.reason).toBeTruthy();
  });

  it('skips when DOCK_TEST_BASH does not exist', () => {
    expect(win({ DOCK_TEST_BASH: 'D:\\nope\\bash.exe' }, [GIT]).bash).toBeUndefined();
  });
});
