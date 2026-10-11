import { utils } from 'ssh2';
import { openSshEd25519 } from '../../docks/ssh-host-key';

/**
 * Deterministic ed25519 key pair for tests. ssh2's `utils.generateKeyPairSync('ed25519')` strips a leading
 * zero byte from the public key (1 in 256 keys), which makes the private key unparseable, so specs must not use it.
 */
export function ed25519KeyPair(seedByte: number): { private: string; public: string } {
  const priv = openSshEd25519(Buffer.alloc(32, seedByte));
  const parsed = utils.parseKey(priv);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('fixture key did not parse');
  return { private: priv, public: `ssh-ed25519 ${parsed.getPublicSSH().toString('base64')}` };
}
