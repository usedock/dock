import { utils } from 'ssh2';
import { openSshEd25519, sshHostKey } from './ssh-host-key';

const reader = (env: Record<string, string>) => ({ get: <T>(key: string) => env[key] as T | undefined });

describe('sshHostKey', () => {
  it('derives the same ed25519 key from the same auth secret and a different one otherwise', () => {
    const a = sshHostKey(reader({ BETTER_AUTH_SECRET: 'a'.repeat(40) }));
    expect(sshHostKey(reader({ BETTER_AUTH_SECRET: 'a'.repeat(40) }))).toBe(a);
    expect(sshHostKey(reader({ BETTER_AUTH_SECRET: 'b'.repeat(40) }))).not.toBe(a);
    const parsed = utils.parseKey(a);
    expect(parsed instanceof Error ? parsed.message : parsed.type).toBe('ssh-ed25519');
  });

  it('signs verifiably with the derived key', () => {
    const parsed = utils.parseKey(openSshEd25519(Buffer.alloc(32, 7)));
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('unparsed');
    const signature = parsed.sign(Buffer.from('hello'));
    expect(parsed.verify(Buffer.from('hello'), signature)).toBe(true);
  });

  it('prefers SSH_HOST_KEY with escaped newlines and refuses non-private keys', () => {
    const pair = utils.generateKeyPairSync('ed25519');
    expect(sshHostKey(reader({ SSH_HOST_KEY: pair.private.replace(/\n/g, '\\n') })).trim()).toBe(pair.private.trim());
    expect(() => sshHostKey(reader({ SSH_HOST_KEY: pair.public }))).toThrow(/SSH_HOST_KEY/);
  });
});
