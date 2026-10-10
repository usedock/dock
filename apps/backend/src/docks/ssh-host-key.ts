import { createHash, createPrivateKey, hkdfSync } from 'crypto';
import { utils } from 'ssh2';
import type { ConfigReader } from '../config/instance';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function sshString(value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

/** Unencrypted `openssh-key-v1` ed25519 private key for a 32-byte seed. */
export function openSshEd25519(seed: Buffer): string {
  const jwk = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
  const pub = Buffer.from(jwk.x as string, 'base64url');
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = createHash('sha256').update(seed).digest().readUInt32BE(0);
  let secret = Buffer.concat([uint32(check), uint32(check), publicBlob, sshString(Buffer.concat([seed, pub])), sshString('dock-gateway')]);
  const padding = (8 - (secret.length % 8)) % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(publicBlob),
    sshString(secret),
  ]);
  const lines = body.toString('base64').match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** SSH_HOST_KEY when set, else an ed25519 key derived from BETTER_AUTH_SECRET so every replica and restart presents the same host key. */
export function sshHostKey(config: ConfigReader): string {
  const explicit = (config.get<string>('SSH_HOST_KEY') ?? '').replace(/\\n/g, '\n').trim();
  const key = explicit ? `${explicit}\n` : openSshEd25519(Buffer.from(hkdfSync('sha256', config.get<string>('BETTER_AUTH_SECRET') ?? '', Buffer.alloc(0), 'dock-ssh-host-key', 32)));
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new Error('SSH_HOST_KEY must be an unencrypted OpenSSH private key');
  return key;
}
