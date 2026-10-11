import { utils } from 'ssh2';
import { ed25519KeyPair } from '../ssh-keys/__fixtures__/ed25519-key-pair';
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

  it('always yields a parseable key, including seeds whose public key starts with a zero byte', () => {
    let leadingZero = 0;
    for (let i = 0; i < 3000; i++) {
      const seed = Buffer.alloc(32);
      seed.writeUInt32BE(i, 28);
      const parsed = utils.parseKey(openSshEd25519(seed));
      if (parsed instanceof Error || Array.isArray(parsed)) throw new Error(`seed ${i}: ${parsed instanceof Error ? parsed.message : 'array'}`);
      if (parsed.getPublicSSH()[19] === 0) leadingZero++;
    }
    expect(leadingZero).toBeGreaterThan(0);
  });

  it('prefers SSH_HOST_KEY with escaped newlines and refuses non-private keys', () => {
    const pair = ed25519KeyPair(4);
    expect(sshHostKey(reader({ SSH_HOST_KEY: pair.private.replace(/\n/g, '\\n') })).trim()).toBe(pair.private.trim());
    expect(() => sshHostKey(reader({ SSH_HOST_KEY: pair.public }))).toThrow(/SSH_HOST_KEY/);
  });
});
