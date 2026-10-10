import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { SealedValue } from '../database/schema';

const IV_BYTES = 12;

/** Sealed store unreadable: missing key, tamper, or wrong key. */
export class SecretsUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({ code: 'service_unavailable', message: 'Secret store unavailable' });
  }
}

/** AES-256-GCM seal with a fresh IV per value; failures close, never leak. */
export function sealValue(key: Buffer, plain: string): SealedValue {
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  } catch {
    throw new SecretsUnavailableException();
  }
}

/** AES-256-GCM open; tamper or key mismatch closes instead of guessing. */
export function openValue(key: Buffer, sealed: SealedValue): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretsUnavailableException();
  }
}
