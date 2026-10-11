import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { connectors, githubInstallations, providerKeys, type Connector } from '../database/schema';
import { openValue, sealValue } from '../environments/secrets';
import { OrganizationsService } from '../organizations/organizations.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CONNECTOR_KINDS, isConnectorKind, type ConnectorCredential, type ConnectorKind } from './connector-kinds';
import { needsRefresh, oauthClient, refreshCredential } from './connector-oauth';
import { verifyCredential } from './connector-verify';

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
  async connect(callerId: string, workspaceId: string, kind: string, token: string): Promise<ConnectorView> {
    const checked = this.checkedKind(kind);
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed || trimmed.length > 2048) throw new BadRequestException({ code: 'validation_error', message: 'token must be 1-2048 characters' });
    const ws = await this.requireAdmin(callerId, workspaceId);
    const credential: ConnectorCredential = { type: 'token', access: trimmed };
    const label = await verifyCredential(this.fetchFn, checked, credential);
    return this.store(ws.id, checked, credential, label, [], callerId);
  }

  /** Upsert shared by the token and OAuth paths. */
  async store(workspaceId: string, kind: ConnectorKind, credential: ConnectorCredential, label: string | null, scopes: string[], userId: string): Promise<ConnectorView> {
    const sealed = sealValue(this.key, JSON.stringify(credential));
    const [row] = await this.db
      .insert(connectors)
      .values({ workspaceId, kind, credentials: sealed, accountLabel: label, scopes, createdBy: userId })
      .onConflictDoUpdate({
        target: [connectors.workspaceId, connectors.kind],
        set: { credentials: sealed, accountLabel: label, scopes, status: 'connected', updatedAt: new Date() },
      })
      .returning();
    return connectorView(row, !!oauthClient(this.config, kind));
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
  async accessFor(workspaceId: string, kind: ConnectorKind): Promise<ConnectorCredential> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.kind, kind)))
      .limit(1);
    if (!row || row.status !== 'connected') throw new ConnectorNotConnectedException([kind]);
    const cred = JSON.parse(openValue(this.key, row.credentials)) as ConnectorCredential;
    if (!needsRefresh(cred)) return cred;
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
    return fresh;
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
