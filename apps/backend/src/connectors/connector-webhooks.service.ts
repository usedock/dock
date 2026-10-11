import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DB, Db } from '../database/database.module';
import { connectorDeliveries, type Connector, type ConnectorKind } from '../database/schema';
import { isUniqueViolation } from '../organizations/organizations.service';
import { createConnectorFetch } from './connector-fetch';
import { admitFigma, admitLinear, admitSentry, admitSlack, type Admission } from './connector-gate';
import { ConnectorRunsService } from './connector-runs.service';
import { figmaTrigger, linearTrigger, sentryTrigger, slackTrigger, type ConnectorTrigger } from './connector-triggers';
import { verifyFigma, verifyLinear, verifySentry, verifySlack, type SignatureCheck } from './connector-webhook-verify';
import { ConnectorsService } from './connectors.service';

const BUSY = 'Dock is busy with other runs here. Try again in a few minutes.';

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

  private readonly fetchFn: typeof fetch;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectors: ConnectorsService,
    private readonly runs: ConnectorRunsService,
    @Optional() options: { fetchFn?: typeof fetch } = {},
  ) {
    this.fetchFn = options?.fetchFn ?? createConnectorFetch();
  }

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
    if (!(await this.claimAll(kind, this.deliveryIds(kind, req, payload)))) return { status: 200, body: { received: true, duplicate: true } };
    const trigger = this.trigger(kind, req, payload, connector);
    if (trigger && kind === 'sentry' && !trigger.reply.org && connector.vendorOrg) trigger.reply.org = connector.vendorOrg;
    if (!trigger) return { status: 200, body: { received: true, ignored: true } };
    // Who sent the event decides whether it may start an agent that acts with the tool's credential.
    const admission = await this.admit(kind, connector, payload);
    if (!admission.ok) {
      if (admission.say) this.runs.notify(connector.workspaceId, kind, trigger.reply, admission.say);
      return { status: 200, body: { received: true, ignored: true, reason: 'requester_not_allowed' } };
    }
    // Acknowledge now (Slack allows three seconds); the run proceeds in the background.
    const outcome = await this.runs.start(connector, trigger).catch((err) => {
      this.logger.warn(`Starting ${kind} run failed: ${(err as Error).message}`);
      return null;
    });
    if (outcome?.status === 'busy') {
      // A Sentry note per dropped alert would flood the issue.
      if (kind !== 'sentry') this.runs.notify(connector.workspaceId, kind, trigger.reply, BUSY);
      return { status: 200, body: { received: true, busy: true, runId: null } };
    }
    return { status: 200, body: { received: true, runId: outcome?.status === 'started' ? outcome.id : null } };
  }

  private async admit(kind: ConnectorKind, connector: Connector, payload: Json): Promise<Admission> {
    switch (kind) {
      case 'sentry':
        return admitSentry(connector);
      case 'figma':
        return admitFigma(connector, payload);
      default: {
        try {
          const access = await this.connectors.accessFor(connector.workspaceId, kind);
          return kind === 'slack' ? await admitSlack(this.fetchFn, access, connector, payload) : await admitLinear(this.fetchFn, access, connector, payload);
        } catch {
          return { ok: false };
        }
      }
    }
  }

  private async route(kind: ConnectorKind, payload: Json): Promise<Connector | null> {
    const id =
      kind === 'linear' ? payload.organizationId : kind === 'slack' ? payload.team_id : kind === 'sentry' ? payload.installation?.uuid : payload.webhook_id;
    if (id === undefined || id === null || String(id) === '') return null;
    return this.connectors.findByExternalId(kind, String(id));
  }

  private async allSlackSecrets(): Promise<string[]> {
    const rows = await this.connectors.listByKind('slack');
    // The app-level secret also counts, so the Request URL can be set before any workspace connects.
    const env = this.connectors.envWebhookSecret('slack');
    return [...new Set([...rows.flatMap((row) => this.connectors.webhookSecretsFor(row)), ...(env ? [env] : [])])];
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

  /** Ids that mark this delivery as seen; Linear and Sentry delivery headers are not signed, so the signed body is claimed too. */
  private deliveryIds(kind: ConnectorKind, req: ConnectorWebhookRequest, payload: Json): string[] {
    const digest = `body:${createHash('sha256').update(req.rawBody).digest('hex')}`;
    switch (kind) {
      case 'linear':
        return [first(req.headers['linear-delivery']), digest].filter((id): id is string => !!id);
      case 'slack':
        return [String(payload.event_id ?? digest)];
      case 'sentry':
        return [first(req.headers['request-id']), digest].filter((id): id is string => !!id);
      default:
        return [`${payload.webhook_id}:${payload.event_type}:${payload.comment_id ?? ''}:${payload.timestamp ?? digest}`];
    }
  }

  /** True when none of the ids was seen: a retry repeats the delivery id, a replay repeats the body. */
  private async claimAll(kind: ConnectorKind, ids: string[]): Promise<boolean> {
    for (const id of ids) if (!(await this.claim(kind, id))) return false;
    return true;
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
