import { describe, expect, it } from 'vitest';
import { resolveBash } from './resolve-bash';

const GIT = 'C:\\Program Files\\Git\\bin\\bash.exe';
const GIT_USR = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
const win = (env: Record<string, string>, present: string[]) =>
  resolveBash({ platform: 'win32', env, exists: (p) => present.includes(p) });

describe('resolveBash', () => {
  it('uses bash from PATH off Windows', () => {
    expect(resolveBash({ platform: 'linux', env: {}, exists: () => false }).bash).toBe('bash');
    expect(resolveBash({ platform: 'darwin', env: {}, exists: () => false }).bash).toBe('bash');
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

  it('finds scoop Git under USERPROFILE and puts usr\\bin first on PATH', () => {
    const p = 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe';
    const r = resolveBash({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me', Path: 'C:\\x' }, exists: (q) => q === p });
    expect(r.bash).toBe(p);
    expect(r.env?.Path).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\usr\\bin;C:\\Users\\me\\scoop\\apps\\git\\current\\bin;C:\\x');
  });

  it('rejects SysWOW64 and Sysnative overrides', () => {
    for (const p of ['C:\\Windows\\SysWOW64\\bash.exe', 'C:/Windows/Sysnative/bash.exe']) {
      expect(win({ DOCK_TEST_BASH: p }, [p]).bash).toBeUndefined();
    }
  });

  it('skips when DOCK_TEST_BASH does not exist', () => {
    expect(win({ DOCK_TEST_BASH: 'D:\\nope\\bash.exe' }, [GIT]).bash).toBeUndefined();
  });
});
