import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiKeys, type ApiKey } from '../database/schema';
import { DB, Db } from '../database/database.module';
import { hashToken, newToken } from '../crypto/tokens';
import { RateLimitService } from '../auth/rate-limit.service';

/** Bearer prefix identifying API keys (vs JWTs) without a DB lookup. */
export const API_KEY_PREFIX = 'dock_';

const MAX_ACTIVE_KEYS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiKeyMetadata {
  id: string;
  name: string;
  keyPrefix: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKey extends ApiKeyMetadata {
  apiKey: string;
}

/** Public metadata view: never carries the secret or its hash. */
function toMetadata(row: ApiKey): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Self-service API keys. Raw secrets exist only in the create() response;
 * only SHA-256 hashes are persisted.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly limits: RateLimitService,
  ) {}

  async create(userId: string, name: string, expiresAt?: Date): Promise<CreatedApiKey> {
    const trimmed = name?.trim() ?? '';
    if (!trimmed || trimmed.length > 100) {
      throw new BadRequestException({
        code: 'validation_error',
        message: 'Name must be 1-100 characters',
      });
    }
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      throw new BadRequestException({
        code: 'validation_error',
        message: 'expiresAt must be a future date',
      });
    }
    const { allowed } = await this.limits.hit(`rl:apikey:${userId}`, 10, 3600);
    if (!allowed) throw new RateLimitedException();
    const active = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt), isNull(apiKeys.dockId)));
    if (active.length >= MAX_ACTIVE_KEYS) {
      throw new ConflictException({
        code: 'api_key_limit_reached',
        message: 'Maximum of 20 active API keys reached',
      });
    }
    const raw = `${API_KEY_PREFIX}${newToken()}`;
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        userId,
        name: trimmed,
        keyHash: hashToken(raw),
        keyPrefix: raw.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8),
        expiresAt: expiresAt ?? null,
      })
      .returning();
    return { ...toMetadata(row), apiKey: raw };
  }

  async list(userId: string): Promise<ApiKeyMetadata[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.dockId)))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toMetadata);
  }

  /** Revokes one key. Unknown, foreign, or malformed ids are 404. */
  async revoke(userId: string, id: string): Promise<{ revoked: boolean }> {
    if (!UUID_RE.test(id)) throw new ApiKeyNotFoundException();
    const rows = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.dockId)))
      .limit(1);
    if (!rows[0]) throw new ApiKeyNotFoundException();
    await this.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    return { revoked: true };
  }
}

export class ApiKeyNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'api_key_not_found', message: 'API key not found' });
  }
}

class RateLimitedException extends HttpException {
  constructor() {
    super(
      { code: 'rate_limited', message: 'Too many requests, try again later' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
