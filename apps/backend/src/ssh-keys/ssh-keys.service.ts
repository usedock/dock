import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { utils } from 'ssh2';
import { RateLimitService } from '../auth/rate-limit.service';
import { DB, Db } from '../database/database.module';
import { sshKeys, type SshKey } from '../database/schema';

const MAX_KEYS = 20;
const MAX_KEY_LENGTH = 16384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']);
/** RSA blobs under ~2048-bit moduli are refused; 2048-bit blobs are 279 bytes. */
const MIN_RSA_BLOB_BYTES = 270;

export interface SshKeyMetadata {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** OpenSSH-style `SHA256:<unpadded base64>` of a public key blob. */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function toMetadata(row: SshKey): SshKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

/** Parses one OpenSSH public key line into its type, blob, and canonical form. */
export function parsePublicKey(line: string): { type: string; blob: Buffer; canonical: string } {
  const trimmed = line?.trim() ?? '';
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH || /[\r\n]/.test(trimmed)) throw invalid('publicKey must be one OpenSSH public key line');
  const parsed = utils.parseKey(trimmed);
  if (parsed instanceof Error || Array.isArray(parsed)) throw invalid('publicKey is not a valid OpenSSH public key');
  if (parsed.isPrivateKey()) throw invalid('publicKey is a private key; paste the .pub file instead');
  if (!ALLOWED_TYPES.has(parsed.type)) throw invalid(`Unsupported key type ${parsed.type}; use ed25519, ECDSA, or RSA`);
  const blob = parsed.getPublicSSH();
  if (parsed.type === 'ssh-rsa' && blob.length < MIN_RSA_BLOB_BYTES) throw invalid('RSA keys must be at least 2048 bits');
  return { type: parsed.type, blob, canonical: `${parsed.type} ${blob.toString('base64')}` };
}

/** Self-service SSH public keys; the SSH gateway authenticates against them. */
@Injectable()
export class SshKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly limits: RateLimitService,
  ) {}

  async create(userId: string, name: string, publicKey: string): Promise<SshKeyMetadata> {
    const trimmed = name?.trim() ?? '';
    if (!trimmed || trimmed.length > 100) throw invalid('Name must be 1-100 characters');
    const key = parsePublicKey(publicKey);
    const { allowed } = await this.limits.hit(`rl:sshkey:${userId}`, 10, 3600);
    if (!allowed) throw new RateLimitedException();
    const existing = await this.db.select({ id: sshKeys.id, fingerprint: sshKeys.fingerprint }).from(sshKeys).where(eq(sshKeys.userId, userId));
    const fingerprint = sshFingerprint(key.blob);
    if (existing.some((row) => row.fingerprint === fingerprint)) {
      throw new ConflictException({ code: 'ssh_key_exists', message: 'This SSH key is already added' });
    }
    if (existing.length >= MAX_KEYS) {
      throw new ConflictException({ code: 'ssh_key_limit_reached', message: `Maximum of ${MAX_KEYS} SSH keys reached` });
    }
    const [row] = await this.db.insert(sshKeys).values({ userId, name: trimmed, publicKey: key.canonical, fingerprint }).returning();
    return toMetadata(row);
  }

  async list(userId: string): Promise<SshKeyMetadata[]> {
    const rows = await this.db.select().from(sshKeys).where(eq(sshKeys.userId, userId)).orderBy(desc(sshKeys.createdAt));
    return rows.map(toMetadata);
  }

  /** Deletes one key. Unknown, foreign, or malformed ids are 404. */
  async remove(userId: string, id: string): Promise<{ deleted: boolean }> {
    if (!UUID_RE.test(id)) throw new SshKeyNotFoundException();
    const rows = await this.db.delete(sshKeys).where(and(eq(sshKeys.id, id), eq(sshKeys.userId, userId))).returning({ id: sshKeys.id });
    if (!rows[0]) throw new SshKeyNotFoundException();
    return { deleted: true };
  }

  /** Every stored key with this blob; one key may belong to several users. */
  async findByBlob(blob: Buffer): Promise<SshKey[]> {
    return this.db.select().from(sshKeys).where(eq(sshKeys.fingerprint, sshFingerprint(blob)));
  }

  async touch(id: string): Promise<void> {
    await this.db.update(sshKeys).set({ lastUsedAt: new Date() }).where(eq(sshKeys.id, id));
  }
}

export class SshKeyNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'ssh_key_not_found', message: 'SSH key not found' });
  }
}

class RateLimitedException extends HttpException {
  constructor() {
    super({ code: 'rate_limited', message: 'Too many requests, try again later' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
