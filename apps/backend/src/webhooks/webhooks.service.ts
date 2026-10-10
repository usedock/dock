import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import { isIP } from 'node:net';
import { newToken } from '../crypto/tokens';
import { openValue, sealValue } from '../environments/secrets';
import type { SealedValue } from '../database/schema';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { DB, Db } from '../database/database.module';
import {
  WEBHOOK_EVENT_TYPES,
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type WebhookEndpoint,
  type WebhookEventType,
} from '../database/schema';
import { defaultResolveHost, isDeniedAddress } from './ssrf-guard';
import { OrganizationsService } from '../organizations/organizations.service';
export const MAX_ENDPOINTS_PER_ORG = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhooksServiceOptions {
  /** DNS resolver seam; specs inject a fake so SSRF checks never touch the network. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/** Endpoint reads for foreign, missing, or deleted ids. */
export class WebhookEndpointNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'webhook_endpoint_not_found', message: 'Webhook endpoint not found' });
  }
}

class SessionRequiredException extends ForbiddenException {
  constructor() {
    super({ code: 'session_required', message: 'This action requires an interactive browser session' });
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

/** Public metadata view: never carries the secret or its sealed copy. */
export interface EndpointMetadata {
  id: string;
  organizationId: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  secretPrefix: string;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toMetadata(row: WebhookEndpoint): EndpointMetadata {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    url: row.url,
    events: row.events,
    secretPrefix: row.secretPrefix,
    disabled: row.disabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreatedEndpoint extends EndpointMetadata {
  secret: string;
}

export interface RecordEventInput {
  type: WebhookEventType;
  dockId: string;
  organizationId: string;
  workspaceId: string;
  state: string;
}

/**
 * Outbound dock lifecycle webhooks. Endpoint writes need a browser session,
 * never a service key; reads are member-visible. Event recording never throws
 * so a webhook failure cannot fail the lifecycle transition it follows.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('WebhooksService');
  private readonly key: Buffer;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    config: ConfigService,
    @Optional() options: WebhooksServiceOptions = {},
  ) {
    this.key = Buffer.from(config.getOrThrow<string>('SECRETS_ENCRYPTION_KEY'), 'hex');
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
  }

  async create(
    caller: RequestUser,
    organizationId: string,
    name: string,
    url: string,
    events: WebhookEventType[],
  ): Promise<CreatedEndpoint> {
    if (caller.isInteractive !== true) throw new SessionRequiredException();
    const trimmed = name?.trim() ?? '';
    if (!trimmed || trimmed.length > 100) throw validationError('Name must be 1-100 characters');
    if (!Array.isArray(events) || events.length === 0) throw validationError('Events must list at least one event type');
    for (const event of events) {
      if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event)) {
        throw validationError('Events must be dock lifecycle event types');
      }
    }
    await this.checkedUrl(url);
    await this.orgs.requireMembership(organizationId, caller.id, 'admin');
    const existing = await this.db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId));
    if (existing.length >= MAX_ENDPOINTS_PER_ORG) {
      throw new ConflictException({
        code: 'endpoints_exceeded',
        message: `Maximum of ${MAX_ENDPOINTS_PER_ORG} webhook endpoints reached`,
      });
    }
    const secret = newToken();
    const [row] = await this.db
      .insert(webhookEndpoints)
      .values({
        organizationId,
        name: trimmed,
        url,
        events,
        secret: sealValue(this.key, secret),
        secretPrefix: secret.slice(0, 8),
      })
      .returning();
    return { ...toMetadata(row), secret };
  }

  async deliveries(callerId: string, organizationId: string, endpointId: string) {
    if (!UUID_RE.test(endpointId)) throw new WebhookEndpointNotFoundException();
    await this.orgs.requireMembership(organizationId, callerId);
    const [endpoint] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId))
      .limit(1);
    if (!endpoint || endpoint.organizationId !== organizationId) throw new WebhookEndpointNotFoundException();
    // Join the event type so the dashboard can label each attempt.
    return this.db
      .select({
        id: webhookAttempts.id,
        eventId: webhookAttempts.eventId,
        endpointId: webhookAttempts.endpointId,
        event: webhookEvents.type,
        status: webhookAttempts.status,
        error: webhookAttempts.error,
        createdAt: webhookAttempts.createdAt,
      })
      .from(webhookAttempts)
      .innerJoin(webhookEvents, eq(webhookEvents.id, webhookAttempts.eventId))
      .where(eq(webhookAttempts.endpointId, endpointId))
      .orderBy(desc(webhookAttempts.createdAt))
      .limit(100);
  }

  async list(callerId: string, organizationId: string): Promise<EndpointMetadata[]> {
    await this.orgs.requireMembership(organizationId, callerId);
    const rows = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map(toMetadata);
  }

  async get(callerId: string, organizationId: string, id: string): Promise<EndpointMetadata> {
    if (!UUID_RE.test(id)) throw new WebhookEndpointNotFoundException();
    await this.orgs.requireMembership(organizationId, callerId);
    const [row] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    if (!row || row.organizationId !== organizationId) throw new WebhookEndpointNotFoundException();
    return toMetadata(row);
  }

  async remove(caller: RequestUser, organizationId: string, id: string): Promise<{ removed: boolean }> {
    if (caller.isInteractive !== true) throw new SessionRequiredException();
    if (!UUID_RE.test(id)) throw new WebhookEndpointNotFoundException();
    await this.orgs.requireMembership(organizationId, caller.id, 'admin');
    const [row] = await this.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1);
    if (!row || row.organizationId !== organizationId) throw new WebhookEndpointNotFoundException();
    await this.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    return { removed: true };
  }


  /** Appends one outbox event plus one delivery per subscribed endpoint; never throws. */
  async record(input: RecordEventInput): Promise<{ id: string } | null> {
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(input.type)) {
      this.logger.warn(`Webhook event type ${input.type} not recorded`);
      return null;
    }
    let eventId: string | null = null;
    try {
      const [row] = await this.db
        .insert(webhookEvents)
        .values({
          type: input.type,
          dockId: input.dockId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          state: input.state,
        })
        .returning({ id: webhookEvents.id });
      eventId = row?.id ?? null;
    } catch (err) {
      this.logger.warn(`Webhook event ${input.type} for dock ${input.dockId} not recorded: ${(err as Error).message}`);
      return null;
    }
    if (!eventId) return null;
    try {
      const targets = await this.targetsFor(input.organizationId, input.type);
      if (targets.length > 0) {
        await this.db
          .insert(webhookDeliveries)
          .values(targets.map((target) => ({ eventId: eventId as string, endpointId: target.id })))
          .onConflictDoNothing();
      }
    } catch (err) {
      this.logger.warn(`Webhook deliveries for event ${eventId} not fanned out: ${(err as Error).message}`);
    }
    return { id: eventId };
  }

  /** Disables an endpoint after a 410. System path: the dispatcher owns retries. */
  async disableEndpoint(id: string): Promise<void> {
    await this.db.update(webhookEndpoints).set({ disabled: true, updatedAt: new Date() }).where(eq(webhookEndpoints.id, id));
  }

  /** Enabled endpoints of one org subscribed to the event type. System path: no auth. */
  async targetsFor(organizationId: string, type: WebhookEventType): Promise<WebhookEndpoint[]> {
    const rows = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId));
    return rows.filter((row) => !row.disabled && row.events.includes(type));
  }

  /** Raw secret for HMAC signing. System path: never leaves the dispatcher. */
  openSecret(sealed: SealedValue): string {
    return openValue(this.key, sealed);
  }

  /**
   * HTTPS 443 only, and the host must not resolve into our own network: an org
   * admin otherwise turns the dispatcher into an SSRF proxy against internal
   * services or the cloud metadata endpoint.
   */
  /** Re-run before every POST so a host re-pointed at a private range after creation is refused. */
  async assertDeliverableUrl(raw: string): Promise<void> {
    await this.checkedUrl(raw);
  }

  private async checkedUrl(raw: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw validationError('Url must be an https URL');
    }
    if (parsed.protocol !== 'https:') throw validationError('Url must be an https URL');
    if (parsed.port !== '' && parsed.port !== '443') throw validationError('Url must use the default https port 443');
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost') throw validationError('Url must not target a private or local network address');
    if (isIP(hostname)) {
      if (isDeniedAddress(hostname)) throw validationError('Url must not target a private or local network address');
      return;
    }
    let addresses: string[];
    try {
      addresses = await this.resolveHost(hostname);
    } catch {
      throw validationError('Url host could not be resolved');
    }
    if (addresses.length === 0 || addresses.some(isDeniedAddress)) {
      throw validationError('Url must not target a private or local network address');
    }
  }
}
