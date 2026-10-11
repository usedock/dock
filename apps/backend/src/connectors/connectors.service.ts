import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { and, eq, lt } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { connectorDeliveries, connectors, githubInstallations, providerKeys, type Connector } from '../database/schema';
import { openValue, sealValue } from '../environments/secrets';
import { OrganizationsService, isUniqueViolation } from '../organizations/organizations.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { assertPublicSentryHost, normalizeSentryHost } from './connector-host';
import { CONNECTOR_KINDS, isConnectorKind, type ConnectorAccess, type ConnectorCredential, type ConnectorKind } from './connector-kinds';
import { needsRefresh, oauthClient, refreshCredential } from './connector-oauth';
import { verifyCredential, type VerifiedIdentity } from './connector-verify';

export interface ConnectorView {
  kind: string;
  type: 'tool' | 'github' | 'model-keys';
  status: 'connected' | 'not_connected' | 'reauth_required';
  accountLabel: string | null;
  scopes: string[];
  oauthAvailable: boolean;
  readOnly: boolean;
  updatedAt: Date | null;
}

export class ConnectorAccountInUseException extends ConflictException {
  constructor() {
    super({ code: 'connector_account_in_use', message: 'This account is already connected to another workspace' });
  }
}

export class ConnectorNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'connector_not_found', message: 'Connector not found' });
  }
}

export class ConnectorNotConnectedException extends ConflictException {
  constructor(kinds: string[]) {
    super({ code: 'connector_not_connected', message: `Connect these first: ${kinds.join(', ')}` });
  }
}

/** Docks with connectors act with the workspace's tool credentials, so like admins-only environment secrets they are for admins. */
export class ConnectorAdminOnlyException extends ForbiddenException {
  constructor() {
    super({ code: 'connector_admin_only', message: 'Only organization admins can launch or open docks that use connectors' });
  }
}

/** Public shape of a connection; field by field so the sealed credential can never be exposed. */
export function connectorView(row: Connector, oauthAvailable: boolean): ConnectorView {
  return {
    kind: row.kind,
    type: 'tool',
    status: row.status,
    accountLabel: row.accountLabel,
    scopes: row.scopes,
    oauthAvailable,
    readOnly: false,
    updatedAt: row.updatedAt,
  };
}

/** Workspace tool connections, sealed at rest; the plaintext is opened only for the gateway. */
@Injectable()
export class ConnectorsService {
  private readonly key: Buffer;
  private readonly fetchFn: typeof fetch;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly workspaces: WorkspacesService,
    private readonly config: ConfigService,
    @Optional() options: { fetchFn?: typeof fetch } = {},
  ) {
    this.key = Buffer.from(config.getOrThrow<string>('SECRETS_ENCRYPTION_KEY'), 'hex');
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async list(callerId: string, workspaceId: string): Promise<ConnectorView[]> {
    const ws = await this.workspaces.getById(callerId, workspaceId);
    const rows = await this.db.select().from(connectors).where(eq(connectors.workspaceId, ws.id));
    const byKind = new Map(rows.map((r) => [r.kind as string, r]));
    const tools = CONNECTOR_KINDS.map((kind): ConnectorView => {
      const row = byKind.get(kind);
      const oauthAvailable = !!oauthClient(this.config, kind);
      return row
        ? connectorView(row, oauthAvailable)
        : { kind, type: 'tool', status: 'not_connected', accountLabel: null, scopes: [], oauthAvailable, readOnly: false, updatedAt: null };
    });
    const installs = await this.db.select().from(githubInstallations).where(eq(githubInstallations.workspaceId, ws.id));
    const keys = await this.db.select().from(providerKeys).where(eq(providerKeys.organizationId, ws.organizationId));
    const latest = (dates: Date[]) => (dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null);
    return [
      ...tools,
      {
        kind: 'github',
        type: 'github',
        status: installs.length ? 'connected' : 'not_connected',
        accountLabel: installs.length ? `${installs.length} installation${installs.length === 1 ? '' : 's'}` : null,
        scopes: [],
        oauthAvailable: false,
        readOnly: true,
        updatedAt: latest(installs.map((i) => i.updatedAt)),
      },
      {
        kind: 'model-keys',
        type: 'model-keys',
        status: keys.length ? 'connected' : 'not_connected',
        accountLabel: null,
        scopes: keys.map((k) => k.provider).sort(),
        oauthAvailable: false,
        readOnly: true,
        updatedAt: latest(keys.map((k) => k.updatedAt)),
      },
    ];
  }

  /** Stores a personal or bot token after checking it against the vendor. */
  async connect(callerId: string, workspaceId: string, kind: string, token: string, host?: string): Promise<ConnectorView> {
    const checked = this.checkedKind(kind);
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed || trimmed.length > 2048) throw new BadRequestException({ code: 'validation_error', message: 'token must be 1-2048 characters' });
    const ws = await this.requireAdmin(callerId, workspaceId);
    const credential: ConnectorCredential = { type: 'token', access: trimmed };
    const origin = await this.checkedHost(checked, host);
    const identity = await verifyCredential(this.fetchFn, checked, credential, origin);
    return this.store(ws.id, checked, credential, identity, [], callerId, origin);
  }

  /** Upsert shared by the token and OAuth paths. */
  async store(
    workspaceId: string,
    kind: ConnectorKind,
    credential: ConnectorCredential,
    identity: VerifiedIdentity,
    scopes: string[],
    userId: string,
    host?: string | null,
  ): Promise<ConnectorView> {
    const sealed = sealValue(this.key, JSON.stringify(credential));
    // A reconnect without an id or host keeps what the webhook setup recorded.
    const optional = {
      ...(identity.externalId ? { externalId: identity.externalId } : {}),
      ...(identity.userId ? { vendorUserId: identity.userId } : {}),
      ...(host !== undefined ? { host } : {}),
    };
    try {
      const [row] = await this.db
        .insert(connectors)
        .values({ workspaceId, kind, credentials: sealed, accountLabel: identity.label, scopes, createdBy: userId, ...optional })
        .onConflictDoUpdate({
          target: [connectors.workspaceId, connectors.kind],
          // The connecting admin owns the connector's docks: triggered runs act on their behalf.
          set: { credentials: sealed, accountLabel: identity.label, scopes, status: 'connected', createdBy: userId, updatedAt: new Date(), ...optional },
        })
        .returning();
      return connectorView(row, !!oauthClient(this.config, kind));
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConnectorAccountInUseException();
      throw err;
    }
  }

  /** Validated Sentry origin (null for sentry.io); other kinds take no host. */
  async checkedHost(kind: ConnectorKind, host: string | undefined): Promise<string | null | undefined> {
    if (host === undefined) return undefined;
    if (kind !== 'sentry') throw new BadRequestException({ code: 'validation_error', message: 'host applies to sentry only' });
    const origin = normalizeSentryHost(host);
    await assertPublicSentryHost(origin);
    return origin;
  }

  async disconnect(callerId: string, workspaceId: string, kind: string): Promise<{ kind: string; status: 'not_connected' }> {
    const checked = this.checkedKind(kind);
    const ws = await this.requireAdmin(callerId, workspaceId);
    const deleted = await this.db
      .delete(connectors)
      .where(and(eq(connectors.workspaceId, ws.id), eq(connectors.kind, checked)))
      .returning({ id: connectors.id });
    if (!deleted.length) throw new ConnectorNotFoundException();
    return { kind: checked, status: 'not_connected' };
  }

  /** Create-time check: every requested kind must be connected in the workspace. */
  async assertConnected(workspaceId: string, kinds: string[]): Promise<ConnectorKind[]> {
    const wanted = [...new Set(kinds)];
    for (const kind of wanted) this.checkedKind(kind);
    if (!wanted.length) return [];
    const rows = await this.db.select().from(connectors).where(eq(connectors.workspaceId, workspaceId));
    const live = new Set(rows.filter((r) => r.status === 'connected').map((r) => r.kind as string));
    const missing = wanted.filter((k) => !live.has(k));
    if (missing.length) throw new ConnectorNotConnectedException(missing);
    return wanted as ConnectorKind[];
  }

  /** Gateway path: the live credential, refreshed when an OAuth token is about to expire. */
  async accessFor(workspaceId: string, kind: ConnectorKind): Promise<ConnectorAccess> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.kind, kind)))
      .limit(1);
    if (!row || row.status !== 'connected') throw new ConnectorNotConnectedException([kind]);
    // DNS may have changed since connect.
    if (kind === 'sentry') await assertPublicSentryHost(row.host);
    const cred = JSON.parse(openValue(this.key, row.credentials)) as ConnectorCredential;
    if (!needsRefresh(cred)) return { ...cred, host: row.host };
    // The row lock makes concurrent calls refresh once; vendors that rotate refresh tokens reject a second use.
    const fresh = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(connectors).where(eq(connectors.id, row.id)).for('update');
      if (!locked || locked.status !== 'connected') return null;
      const current = JSON.parse(openValue(this.key, locked.credentials)) as ConnectorCredential;
      if (!needsRefresh(current)) return current;
      const client = oauthClient(this.config, kind);
      let next: ConnectorCredential | null = null;
      try {
        next = client ? await refreshCredential(this.fetchFn, kind, client, current) : null;
      } catch {
        next = null;
      }
      if (!next) {
        await tx.update(connectors).set({ status: 'reauth_required', updatedAt: new Date() }).where(eq(connectors.id, row.id));
        return null;
      }
      await tx.update(connectors).set({ credentials: sealValue(this.key, JSON.stringify(next)), updatedAt: new Date() }).where(eq(connectors.id, row.id));
      return next;
    });
    if (!fresh) throw new ConnectorNotConnectedException([kind]);
    return { ...fresh, host: row.host };
  }

  /** Records how this connector's inbound webhooks are verified and routed; a Figma passcode is generated when omitted and shown once. */
  async setWebhook(
    callerId: string,
    workspaceId: string,
    kind: string,
    input: { secret?: string; externalId?: string },
  ): Promise<{ kind: ConnectorKind; externalId: string | null; secret?: string }> {
    const checked = this.checkedKind(kind);
    const ws = await this.requireAdmin(callerId, workspaceId);
    const [row] = await this.db.select().from(connectors).where(and(eq(connectors.workspaceId, ws.id), eq(connectors.kind, checked))).limit(1);
    if (!row) throw new ConnectorNotFoundException();
    const given = input.secret?.trim();
    const generated = !given && checked === 'figma' ? randomBytes(24).toString('hex') : undefined;
    const secret = given || generated;
    const typed = input.externalId?.trim();
    const externalId = typed || row.externalId;
    if (!secret && !row.webhookSecret && !this.envWebhookSecret(checked)) {
      throw new BadRequestException({ code: 'webhook_secret_required', message: 'secret is required for this tool' });
    }
    // An id the admin types (always for Sentry and Figma) is not proven by the token, so only a secret the admin holds can vouch for it.
    const typedId = checked === 'sentry' || checked === 'figma' || (!!typed && typed !== row.externalId);
    if (typedId && !secret && !row.webhookSecret) {
      throw new BadRequestException({ code: 'webhook_secret_required', message: 'secret is required for this tool' });
    }
    if ((checked === 'sentry' || checked === 'figma') && !externalId) {
      throw new BadRequestException({ code: 'validation_error', message: checked === 'figma' ? 'externalId must be the Figma webhook id' : 'externalId must be the Sentry installation uuid' });
    }
    try {
      await this.db
        .update(connectors)
        .set({ ...(secret ? { webhookSecret: sealValue(this.key, secret) } : {}), externalId, updatedAt: new Date() })
        .where(eq(connectors.id, row.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConnectorAccountInUseException();
      throw err;
    }
    return { kind: checked, externalId: externalId ?? null, ...(generated ? { secret: generated } : {}) };
  }

  /** App-level secret, only for kinds whose routing id the token proves (Linear, Slack). */
  envWebhookSecret(kind: ConnectorKind): string | null {
    const name = kind === 'linear' ? 'LINEAR_WEBHOOK_SECRET' : kind === 'slack' ? 'SLACK_SIGNING_SECRET' : null;
    return (name && this.config.get<string>(name)) || null;
  }

  /** Inbound routing: the connector a vendor account id belongs to. */
  async findByExternalId(kind: ConnectorKind, externalId: string): Promise<Connector | null> {
    const [row] = await this.db.select().from(connectors).where(and(eq(connectors.kind, kind), eq(connectors.externalId, externalId))).limit(1);
    return row ?? null;
  }

  /** Dedupe rows only matter inside vendor retry windows. */
  async pruneDeliveries(olderThanDays = 7): Promise<void> {
    await this.db.delete(connectorDeliveries).where(lt(connectorDeliveries.receivedAt, new Date(Date.now() - olderThanDays * 86_400_000)));
  }

  async listByKind(kind: ConnectorKind): Promise<Connector[]> {
    return this.db.select().from(connectors).where(eq(connectors.kind, kind));
  }

  /** Secrets that may sign this connector's webhooks: its own, else the app-level one. */
  webhookSecretsFor(row: Connector): string[] {
    if (row.webhookSecret) return [openValue(this.key, row.webhookSecret)];
    const env = this.envWebhookSecret(row.kind);
    return env ? [env] : [];
  }

  /** The workspace when the caller is an org admin; members and outsiders are refused. */
  async requireAdmin(callerId: string, workspaceId: string): Promise<{ id: string; organizationId: string }> {
    const ws = await this.workspaces.getById(callerId, workspaceId);
    await this.orgs.requireMembership(ws.organizationId, callerId, 'admin');
    return ws;
  }

  private checkedKind(kind: string): ConnectorKind {
    if (!isConnectorKind(kind)) {
      throw new BadRequestException({ code: 'validation_error', message: `kind must be one of: ${CONNECTOR_KINDS.join(', ')}` });
    }
    return kind;
  }

  /** Exposed so the OAuth service shares the validated kind check. */
  kindOf(kind: string): ConnectorKind {
    return this.checkedKind(kind);
  }
}
