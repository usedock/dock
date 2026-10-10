import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, lte } from 'drizzle-orm';
import { RateLimitService } from '../auth/rate-limit.service';
import { DB, Db } from '../database/database.module';
import {
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
  webhookEvents,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
} from '../database/schema';
import { WebhooksService } from './webhooks.service';
import { signWebhook } from './webhook-signing';
import { WebhookTransport } from './webhook-transport';

/** Deliveries claimed per tick; keeps one slow org from starving others. */
export const DISPATCH_BATCH_SIZE = 50;
/** Attempts before a delivery is parked as gave_up; the attempts log keeps every try. */
export const MAX_DELIVERY_ATTEMPTS = 25;
/** Per-endpoint send cap per minute; over-limit rows wait for the next tick. */
export const DISPATCH_PER_ENDPOINT_PER_MINUTE = 60;
export const DISPATCH_POST_TIMEOUT_MS = 10000;
/** Signature header receivers verify; same t,v1 shape as the inbound Stripe path. */
export const WEBHOOK_SIGNATURE_HEADER = 'dock-signature';

export type DeliveryOutcome = 'sent' | 'retry' | 'gave_up' | 'disabled';

/**
 * Maps one attempt to its outcome. 2xx lands; 410 means the receiver is gone;
 * 429/5xx and transport failures back off; any other 4xx is a permanent
 * receiver rejection, not something retries will fix.
 */
export function classifyDelivery(status: number | null): DeliveryOutcome {
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'sent';
  if (status === 410) return 'disabled';
  if (status === 429 || status === 408 || status >= 500) return 'retry';
  return 'gave_up';
}

/** Backoff before the next try: 30s doubling to a 1h ceiling. */
export function backoffDelayMs(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600) * 1000;
}

export interface WebhookPayload {
  id: string;
  type: string;
  occurredAt: Date;
  dock: { id: string; state: string };
  organizationId: string | null;
  workspaceId: string | null;
}

export function eventPayload(event: WebhookEvent): string {
  const payload: WebhookPayload = {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    dock: { id: event.dockId, state: event.state },
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
  };
  return JSON.stringify(payload);
}

/**
 * Poll-loop fan-out for pending webhook deliveries. Every attempt is logged;
 * a dead receiver never blocks other endpoints or the lifecycle that queued
 * the event. The tick never rejects.
 */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger('WebhookDispatchService');
  private timer?: NodeJS.Timeout;
  // Guards against a slow tick (many slow receivers) overlapping the next
  // setInterval firing, which would otherwise re-select the same still-pending
  // rows and double-post them before the first tick's status update lands.
  private polling = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly webhooks: WebhooksService,
    private readonly transport: WebhookTransport,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  async pollOnce(): Promise<{ processed: number; sent: number }> {
    if (this.polling) return { processed: 0, sent: 0 };
    this.polling = true;
    try {
      return await this.pollOnceInner();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnceInner(): Promise<{ processed: number; sent: number }> {
    let processed = 0;
    let sent = 0;
    let due: WebhookDelivery[];
    try {
      due = await this.db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date())))
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(DISPATCH_BATCH_SIZE);
    } catch (err) {
      this.logger.warn(`Webhook dispatch poll failed: ${(err as Error).message}`);
      return { processed, sent };
    }
    for (const delivery of due) {
      processed += 1;
      try {
        if (await this.deliverOne(delivery)) sent += 1;
      } catch (err) {
        this.logger.warn(`Webhook delivery ${delivery.id} failed: ${(err as Error).message}`);
      }
    }
    return { processed, sent };
  }

  /** One due delivery: rate-cap, sign, post, and record the attempt. Never throws. */
  private async deliverOne(delivery: WebhookDelivery): Promise<boolean> {
    const [event] = await this.db.select().from(webhookEvents).where(eq(webhookEvents.id, delivery.eventId)).limit(1);
    const [endpoint] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, delivery.endpointId))
      .limit(1);
    if (!event || !endpoint || endpoint.disabled) {
      await this.markGaveUp(delivery);
      return false;
    }
    let allowed = true;
    try {
      ({ allowed } = await this.limits.hit(`rl:webhook:${endpoint.id}`, DISPATCH_PER_ENDPOINT_PER_MINUTE, 60));
    } catch (err) {
      this.logger.warn(`Webhook rate limiter unavailable for ${endpoint.id}: ${(err as Error).message}`);
      return false;
    }
    if (!allowed) return false;
    const body = eventPayload(event);
    const secret = this.webhooks.openSecret(endpoint.secret);
    let status: number | null = null;
    let error: string | null = null;
    try {
      await this.webhooks.assertDeliverableUrl(endpoint.url);
      ({ status } = await this.transport.post({
        url: endpoint.url,
        body,
        headers: { [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body) },
        timeoutMs: DISPATCH_POST_TIMEOUT_MS,
      }));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await this.recordAttempt(delivery, status, error);
    const outcome = classifyDelivery(status);
    if (outcome === 'sent') {
      await this.markSent(delivery);
      return true;
    }
    if (outcome === 'disabled') {
      await this.webhooks.disableEndpoint(endpoint.id);
      await this.markGaveUp(delivery);
      this.logger.log(`Webhook endpoint ${endpoint.id} disabled after 410`);
      return false;
    }
    await this.scheduleRetry(delivery, outcome);
    return false;
  }

  private async recordAttempt(delivery: WebhookDelivery, status: number | null, error: string | null): Promise<void> {
    await this.db.insert(webhookAttempts).values({
      eventId: delivery.eventId,
      endpointId: delivery.endpointId,
      status,
      error,
    });
  }

  private async markSent(delivery: WebhookDelivery): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: 'sent', updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  }

  private async markGaveUp(delivery: WebhookDelivery): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: 'gave_up', updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  }

  private async scheduleRetry(delivery: WebhookDelivery, outcome: DeliveryOutcome): Promise<void> {
    const attempts = (delivery.attempts ?? 0) + 1;
    if (outcome === 'gave_up' || attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.markGaveUp(delivery);
      return;
    }
    await this.db
      .update(webhookDeliveries)
      .set({ attempts, nextAttemptAt: new Date(Date.now() + backoffDelayMs(attempts)), updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  }

  onModuleInit(): void {
    const raw = Number(this.config.get<string>('WEBHOOK_DISPATCH_MS') ?? 15000);
    const ms = Number.isFinite(raw) && raw > 0 ? raw : 15000;
    this.logger.log(`Webhook dispatcher active every ${ms}ms`);
    this.timer = setInterval(() => {
      void this.pollOnce().catch((err: Error) => this.logger.error(`Webhook dispatch tick failed: ${err.message}`));
    }, ms);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
