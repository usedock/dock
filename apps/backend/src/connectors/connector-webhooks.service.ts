import { BadRequestException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DB, Db } from '../database/database.module';
import { connectorDeliveries, type Connector, type ConnectorKind } from '../database/schema';
import { isUniqueViolation } from '../organizations/organizations.service';
import { ConnectorRunsService } from './connector-runs.service';
import { figmaTrigger, linearTrigger, sentryTrigger, slackTrigger, type ConnectorTrigger } from './connector-triggers';
import { verifyFigma, verifyLinear, verifySentry, verifySlack, type SignatureCheck } from './connector-webhook-verify';
import { ConnectorsService } from './connectors.service';

type Headers = Record<string, string | string[] | undefined>;
type Json = Record<string, any>;

export interface ConnectorWebhookRequest {
  headers: Headers;
  rawBody: Buffer;
}

export interface WebhookOutcome {
  status: number;
  /** Sent as is; Slack's challenge must not be wrapped. */
  body: Record<string, unknown> | string;
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function refused(check: Exclude<SignatureCheck, 'ok'>): UnauthorizedException {
  return check === 'stale'
    ? new UnauthorizedException({ code: 'stale_webhook', message: 'Webhook timestamp is outside the allowed window' })
    : new UnauthorizedException({ code: 'invalid_signature', message: 'Invalid webhook signature' });
}

/** Inbound events from connected tools: verified per vendor scheme, routed to a workspace, deduplicated, then handed to a run. */
@Injectable()
export class ConnectorWebhooksService {
  private readonly logger = new Logger(ConnectorWebhooksService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectors: ConnectorsService,
    private readonly runs: ConnectorRunsService,
  ) {}

  async handle(kind: ConnectorKind, req: ConnectorWebhookRequest, nowMs = Date.now()): Promise<WebhookOutcome> {
    let payload: Json;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as Json;
    } catch {
      throw new BadRequestException({ code: 'validation_error', message: 'Body must be JSON' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException({ code: 'validation_error', message: 'Body must be a JSON object' });
    }
    // Slack's URL check names no workspace, so any connected Slack secret may vouch for it.
    if (kind === 'slack' && payload.type === 'url_verification') {
      const secrets = await this.allSlackSecrets();
      this.verify(kind, req, payload, secrets, nowMs);
      return { status: 200, body: String(payload.challenge ?? '') };
    }
    const connector = await this.route(kind, payload);
    if (!connector) throw new NotFoundException({ code: 'connector_not_found', message: 'No workspace is connected for this account' });
    this.verify(kind, req, payload, this.connectors.webhookSecretsFor(connector), nowMs);
    const deliveryId = this.deliveryId(kind, req, payload);
    if (!(await this.claim(kind, deliveryId))) return { status: 200, body: { received: true, duplicate: true } };
    const trigger = this.trigger(kind, req, payload, connector);
    if (!trigger) return { status: 200, body: { received: true, ignored: true } };
    // Acknowledge now (Slack allows three seconds); the run proceeds in the background.
    const runId = await this.runs.start(connector, trigger).catch((err) => {
      this.logger.warn(`Starting ${kind} run failed: ${(err as Error).message}`);
      return null;
    });
    return { status: 200, body: { received: true, runId } };
  }

  private async route(kind: ConnectorKind, payload: Json): Promise<Connector | null> {
    const id =
      kind === 'linear' ? payload.organizationId : kind === 'slack' ? payload.team_id : kind === 'sentry' ? payload.installation?.uuid : payload.webhook_id;
    if (id === undefined || id === null || String(id) === '') return null;
    return this.connectors.findByExternalId(kind, String(id));
  }

  private async allSlackSecrets(): Promise<string[]> {
    const rows = await this.connectors.listByKind('slack');
    return rows.flatMap((row) => this.connectors.webhookSecretsFor(row));
  }

  private verify(kind: ConnectorKind, req: ConnectorWebhookRequest, payload: Json, secrets: string[], nowMs: number): void {
    const h = req.headers;
    let check: SignatureCheck;
    switch (kind) {
      case 'linear':
        check = verifyLinear(secrets, req.rawBody, first(h['linear-signature']), payload.webhookTimestamp, nowMs);
        break;
      case 'slack':
        check = verifySlack(secrets, req.rawBody, first(h['x-slack-signature']), first(h['x-slack-request-timestamp']), nowMs);
        break;
      case 'sentry':
        check = verifySentry(secrets, req.rawBody, first(h['sentry-hook-signature']), payload);
        break;
      default:
        check = verifyFigma(secrets, payload.passcode);
    }
    if (check !== 'ok') throw refused(check);
  }

  /** Vendor delivery id where one exists, else a stable digest of what identifies the event. */
  private deliveryId(kind: ConnectorKind, req: ConnectorWebhookRequest, payload: Json): string {
    const digest = () => createHash('sha256').update(req.rawBody).digest('hex');
    switch (kind) {
      case 'linear':
        return first(req.headers['linear-delivery']) ?? digest();
      case 'slack':
        return String(payload.event_id ?? digest());
      case 'sentry':
        return first(req.headers['request-id']) ?? digest();
      default:
        return `${payload.webhook_id}:${payload.event_type}:${payload.comment_id ?? ''}:${payload.timestamp ?? digest()}`;
    }
  }

  /** True when this delivery is new. */
  private async claim(kind: ConnectorKind, deliveryId: string): Promise<boolean> {
    try {
      await this.db.insert(connectorDeliveries).values({ kind, deliveryId });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  private trigger(kind: ConnectorKind, req: ConnectorWebhookRequest, payload: Json, connector: Connector): ConnectorTrigger | null {
    switch (kind) {
      case 'linear':
        return linearTrigger(payload, connector.vendorUserId);
      case 'slack':
        return slackTrigger(payload);
      case 'sentry':
        return sentryTrigger(first(req.headers['sentry-hook-resource']), payload);
      default:
        return figmaTrigger(payload, connector.vendorUserId);
    }
  }
}
