import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import {
  PROVIDER_ENV_VARS,
  PROVIDER_NAMES,
  providerKeys,
  type ProviderName,
} from '../database/schema';
import { openValue, sealValue } from '../environments/secrets';
import {
  OrganizationNotFoundException,
  OrganizationsService,
} from '../organizations/organizations.service';

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

export interface ProviderKeyMeta {
  provider: ProviderName;
  configured: boolean;
  updatedAt: Date | null;
}

/** Org provider keys, sealed at rest; plaintext exists only in set/reveal responses and injection. */
@Injectable()
export class AgentCredentialsService {
  private readonly key: Buffer;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    config: ConfigService,
  ) {
    this.key = Buffer.from(config.getOrThrow<string>('SECRETS_ENCRYPTION_KEY'), 'hex');
  }

  async list(callerId: string, orgId: string): Promise<ProviderKeyMeta[]> {
    await this.memberOrg(callerId, orgId, 'member');
    const rows = await this.db.select().from(providerKeys).where(eq(providerKeys.organizationId, orgId));
    const byProvider = new Map(rows.map((r) => [r.provider as ProviderName, r]));
    return PROVIDER_NAMES.map((provider) => {
      const row = byProvider.get(provider);
      return { provider, configured: !!row, updatedAt: row?.updatedAt ?? null };
    });
  }

  async set(callerId: string, orgId: string, provider: string, key: string): Promise<ProviderKeyMeta> {
    const name = this.checkedProvider(provider);
    if (typeof key !== 'string' || !key.trim() || key.length > 512) {
      throw validationError('key must be 1-512 characters');
    }
    await this.memberOrg(callerId, orgId, 'admin');
    const [row] = await this.db
      .insert(providerKeys)
      .values({ organizationId: orgId, provider: name, secret: sealValue(this.key, key) })
      .onConflictDoUpdate({
        target: [providerKeys.organizationId, providerKeys.provider],
        set: { secret: sealValue(this.key, key), updatedAt: new Date() },
      })
      .returning();
    return { provider: name, configured: true, updatedAt: row.updatedAt };
  }

  async reveal(callerId: string, orgId: string, provider: string): Promise<{ provider: ProviderName; key: string }> {
    const name = this.checkedProvider(provider);
    await this.memberOrg(callerId, orgId, 'admin');
    const [row] = await this.db
      .select()
      .from(providerKeys)
      .where(and(eq(providerKeys.organizationId, orgId), eq(providerKeys.provider, name)))
      .limit(1);
    if (!row) throw new ProviderKeysNotFoundException();
    return { provider: name, key: openValue(this.key, row.secret) };
  }

  async remove(callerId: string, orgId: string, provider: string): Promise<ProviderKeyMeta> {
    const name = this.checkedProvider(provider);
    await this.memberOrg(callerId, orgId, 'admin');
    const deleted = await this.db
      .delete(providerKeys)
      .where(and(eq(providerKeys.organizationId, orgId), eq(providerKeys.provider, name)))
      .returning({ id: providerKeys.id });
    if (!deleted.length) throw new ProviderKeysNotFoundException();
    return { provider: name, configured: false, updatedAt: null };
  }

  /** Driver path: plaintext vars for requiredKeys whose provider is set; no membership check. */
  async varsFor(orgId: string, requiredKeys: string[]): Promise<{ vars: Record<string, string>; providers: ProviderName[] }> {
    if (!requiredKeys.length) return { vars: {}, providers: [] };
    const rows = await this.db.select().from(providerKeys).where(eq(providerKeys.organizationId, orgId));
    const secrets = new Map(rows.map((r) => [r.provider as ProviderName, r.secret]));
    const vars: Record<string, string> = {};
    const providers = new Set<ProviderName>();
    for (const [provider, names] of Object.entries(PROVIDER_ENV_VARS) as [ProviderName, string[]][]) {
      const secret = secrets.get(provider);
      if (!secret) continue;
      const wanted = names.filter((n) => requiredKeys.includes(n));
      if (!wanted.length) continue;
      const plain = openValue(this.key, secret);
      for (const name of wanted) vars[name] = plain;
      providers.add(provider);
    }
    return { vars, providers: [...providers] };
  }

  private checkedProvider(provider: string): ProviderName {
    if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) {
      throw validationError(`provider must be one of: ${PROVIDER_NAMES.join(', ')}`);
    }
    return provider as ProviderName;
  }

  private async memberOrg(callerId: string, orgId: string, minRole: 'member' | 'admin'): Promise<void> {
    try {
      await this.orgs.requireMembership(orgId, callerId, minRole);
    } catch (err) {
      if (err instanceof OrganizationNotFoundException) throw new ProviderKeysNotFoundException();
      throw err;
    }
  }
}

export class ProviderKeysNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'provider_keys_not_found', message: 'Provider keys not found' });
  }
}
