import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import {
  NOTIFICATION_ALERT_TYPES,
  NOTIFICATION_AUDIENCE,
  billingPlans,
  docks,
  notificationEdges,
  notificationEvents,
  notificationInbox,
  notificationOrgPrefs,
  notificationUserPrefs,
  organizationMembers,
  snapshots,
  subscriptions,
  users,
  workspaces,
  type NotificationAlertType,
  type NotificationEvent,
} from '../database/schema';
import { OrganizationsService } from '../organizations/organizations.service';
import { MailService, type MailContext, type MailTemplate } from '../mail/mail.service';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { publicAppUrl } from '../config/instance';

/** Warning line and re-arm hysteresis as fractions of the class disk floor. */
export const DISK_WARNING_RATIO = 0.8;
export const DISK_REARM_RATIO = 0.75;
export const DISK_FULL_RATIO = 0.99;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_TYPES = new Set<string>(NOTIFICATION_ALERT_TYPES);
/** Recovery/hold lifecycle does not exist yet; these types must never fire. */
const DORMANT_TYPES = new Set<string>(['auto_recovered', 'held_after_loss']);

export class NotificationNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'notification_not_found', message: 'Notification not found' });
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

interface Cursor {
  t: string;
  id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string' || Number.isNaN(Date.parse(parsed.t))) {
      throw new Error('bad cursor');
    }
    return { t: parsed.t, id: parsed.id };
  } catch {
    throw validationError('Invalid cursor');
  }
}

export interface InboxView {
  id: string;
  eventId: string;
  type: NotificationAlertType;
  title: string;
  body: string;
  dockId: string | null;
  linkPath: string;
  read: boolean;
  occurredAt: Date;
}

export interface InboxPage {
  notifications: InboxView[];
  nextCursor: string | null;
  /** Caller's unread rows across the whole inbox, not just this page. */
  unreadCount: number;
}

export interface PreferenceView {
  type: NotificationAlertType;
  audience: 'billing' | 'dock';
  enabled: boolean;
  emailEnabled: boolean;
}

export interface EmitInput {
  type: NotificationAlertType;
  organizationId: string;
  workspaceId?: string | null;
  dockId?: string | null;
  /** Stable per crossing; the first claim wins, repeats are no-ops. */
  edgeKey: string;
  dedupeKey: string;
  title: string;
  body: string;
  linkPath: string;
  template: MailTemplate;
  subject: string;
  context: Omit<MailContext, 'subject'>;
}

/**
 * Human notification plane: one org-scoped outbox event per trigger, fanned
 * out to per-user inbox rows plus role-filtered email. Emission never throws
 * so a notification failure cannot fail the transition it follows.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationsService');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async listInbox(callerId: string, cursor?: string, limit = 50): Promise<InboxPage> {
    const take = this.checkedLimit(limit);
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const conditions = [eq(notificationInbox.userId, callerId)];
    if (after) {
      const at = new Date(after.t);
      conditions.push(
        or(
          lt(notificationInbox.createdAt, at),
          and(eq(notificationInbox.createdAt, at), lt(notificationInbox.id, after.id)),
        ) as never,
      );
    }
    const [rows, [unread]] = await Promise.all([
      this.db
        .select({ inbox: notificationInbox, event: notificationEvents })
        .from(notificationInbox)
        .innerJoin(notificationEvents, eq(notificationEvents.id, notificationInbox.eventId))
        .where(and(...conditions))
        .orderBy(desc(notificationInbox.createdAt), desc(notificationInbox.id))
        .limit(take + 1),
      this.db
        .select({ n: count() })
        .from(notificationInbox)
        .where(and(eq(notificationInbox.userId, callerId), isNull(notificationInbox.readAt))),
    ]);
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return {
      notifications: page.map(({ inbox, event }) => ({
        id: inbox.id,
        eventId: event.id,
        type: event.type,
        title: event.title,
        body: event.body,
        dockId: event.dockId,
        linkPath: event.linkPath,
        read: inbox.readAt !== null,
        occurredAt: event.occurredAt,
      })),
      nextCursor: rows.length > take && last ? encodeCursor(last.inbox.createdAt, last.inbox.id) : null,
      unreadCount: unread?.n ?? 0,
    };
  }

  /** Marks every unread row of the caller read; other members' rows stay untouched. */
  async markAllRead(callerId: string): Promise<{ updated: number }> {
    const rows = await this.db
      .update(notificationInbox)
      .set({ readAt: new Date() })
      .where(and(eq(notificationInbox.userId, callerId), isNull(notificationInbox.readAt)))
      .returning({ id: notificationInbox.id });
    return { updated: rows.length };
  }

  async markRead(callerId: string, id: string): Promise<{ id: string; read: boolean }> {
    if (!UUID_RE.test(id)) throw new NotificationNotFoundException();
    const [row] = await this.db
      .select()
      .from(notificationInbox)
      .where(and(eq(notificationInbox.id, id), eq(notificationInbox.userId, callerId)))
      .limit(1);
    if (!row) throw new NotificationNotFoundException();
    if (!row.readAt) {
      await this.db.update(notificationInbox).set({ readAt: new Date() }).where(eq(notificationInbox.id, id));
    }
    return { id, read: true };
  }

  async getPreferences(callerId: string, organizationId: string): Promise<{ organizationId: string; preferences: PreferenceView[] }> {
    await this.orgs.requireMembership(organizationId, callerId);
    const [orgRows, userRows] = await Promise.all([
      this.db
        .select()
        .from(notificationOrgPrefs)
        .where(eq(notificationOrgPrefs.organizationId, organizationId)),
      this.db
        .select()
        .from(notificationUserPrefs)
        .where(eq(notificationUserPrefs.userId, callerId)),
    ]);
    const orgOff = new Map(orgRows.filter((r) => !r.enabled).map((r) => [r.alertType, true]));
    const mailOff = new Map(userRows.filter((r) => !r.emailEnabled).map((r) => [r.alertType, true]));
    return {
      organizationId,
      preferences: NOTIFICATION_ALERT_TYPES.map((type) => ({
        type,
        audience: NOTIFICATION_AUDIENCE[type],
        enabled: !orgOff.has(type),
        emailEnabled: !mailOff.has(type),
      })),
    };
  }

  async updateOrgPreference(
    caller: RequestUser,
    organizationId: string,
    type: NotificationAlertType,
    enabled: boolean,
  ): Promise<{ organizationId: string; type: NotificationAlertType; enabled: boolean }> {
    if (caller.isInteractive !== true) throw new SessionRequiredException();
    if (!KNOWN_TYPES.has(type)) throw validationError('Type must be a known alert type');
    await this.orgs.requireMembership(organizationId, caller.id, 'admin');
    await this.db
      .insert(notificationOrgPrefs)
      .values({ organizationId, alertType: type, enabled })
      .onConflictDoUpdate({
        target: [notificationOrgPrefs.organizationId, notificationOrgPrefs.alertType],
        set: { enabled, updatedAt: new Date() },
      });
    return { organizationId, type, enabled };
  }

  async updatePersonalPreference(
    callerId: string,
    type: NotificationAlertType,
    emailEnabled: boolean,
  ): Promise<{ type: NotificationAlertType; emailEnabled: boolean }> {
    if (!KNOWN_TYPES.has(type)) throw validationError('Type must be a known alert type');
    await this.db
      .insert(notificationUserPrefs)
      .values({ userId: callerId, alertType: type, emailEnabled })
      .onConflictDoUpdate({
        target: [notificationUserPrefs.userId, notificationUserPrefs.alertType],
        set: { emailEnabled, updatedAt: new Date() },
      });
    return { type, emailEnabled };
  }

  /** Core emission: edge-claim, outbox write, preference-gated fan-out. Never throws. */
  async emit(input: EmitInput): Promise<{ id: string } | null> {
    try {
      if (!KNOWN_TYPES.has(input.type)) {
        this.logger.warn(`Notification type ${input.type} not recorded`);
        return null;
      }
      if (DORMANT_TYPES.has(input.type)) {
        this.logger.warn(`Notification type ${input.type} is dormant until the recovery lifecycle lands`);
        return null;
      }
      const claimed = await this.db
        .insert(notificationEdges)
        .values({ organizationId: input.organizationId, edgeKey: input.edgeKey })
        .onConflictDoNothing({ target: [notificationEdges.organizationId, notificationEdges.edgeKey] })
        .returning({ edgeKey: notificationEdges.edgeKey });
      if (!claimed.length) return null;
      const [event] = await this.db
        .insert(notificationEvents)
        .values({
          type: input.type,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId ?? null,
          dockId: input.dockId ?? null,
          dedupeKey: input.dedupeKey,
          title: input.title,
          body: input.body,
          linkPath: input.linkPath,
        })
        .returning();
      if (!event) return null;
      await this.fanOut(event, {
        template: input.template,
        subject: input.subject,
        context: input.context,
      });
      return { id: event.id };
    } catch (err) {
      this.logger.warn(`Notification ${input.type} for org ${input.organizationId} not recorded: ${(err as Error).message}`);
      return null;
    }
  }

  /** Dock-class fan-out to workspace members. System path: never throws. */
  async dockStoppedResponding(input: { dockId: string; workspaceId: string; dockName: string; at: Date }): Promise<{ id: string } | null> {
    try {
      const orgId = await this.orgForWorkspace(input.workspaceId);
      if (!orgId) return null;
      const days = await this.retentionDaysFor(orgId);
      const kept = days === null ? 'per your plan’s retention window' : `${days} days`;
      const body = `${input.dockName} went silent. The disk is kept ${kept} and billing is paused.`;
      return await this.emit({
        type: 'stopped_responding',
        organizationId: orgId,
        workspaceId: input.workspaceId,
        dockId: input.dockId,
        edgeKey: `stopped_responding:${input.dockId}:${input.at.toISOString()}`,
        dedupeKey: `stopped_responding:${input.dockId}`,
        title: 'Dock stopped responding',
        body,
        linkPath: `/docks/${input.dockId}`,
        template: 'stopped_responding',
        subject: `Dock stopped responding: ${input.dockName}`,
        context: { linkUrl: this.appUrl(`/docks/${input.dockId}`), dockName: input.dockName, detail: body },
      });
    } catch (err) {
      this.logger.warn(`Stopped-responding for dock ${input.dockId} not recorded: ${(err as Error).message}`);
      return null;
    }
  }

  /** Refused stop keeps the dock running with billing paused. System path: never throws. */
  async dockStopRefused(input: { dockId: string; workspaceId: string; dockName: string; at: Date }): Promise<{ id: string } | null> {
    try {
      const orgId = await this.orgForWorkspace(input.workspaceId);
      if (!orgId) return null;
      const body = `${input.dockName} is still running because its snapshot keeps failing. Billing is paused; the stop is forced after 3 days.`;
      return await this.emit({
        type: 'stop_refused',
        organizationId: orgId,
        workspaceId: input.workspaceId,
        dockId: input.dockId,
        edgeKey: `stop_refused:${input.dockId}:${input.at.toISOString()}`,
        dedupeKey: `stop_refused:${input.dockId}`,
        title: 'Dock could not be stopped',
        body,
        linkPath: `/docks/${input.dockId}`,
        template: 'stop_refused',
        subject: `Dock could not be stopped: ${input.dockName}`,
        context: { linkUrl: this.appUrl(`/docks/${input.dockId}`), dockName: input.dockName, detail: body },
      });
    } catch (err) {
      this.logger.warn(`Stop-refused for dock ${input.dockId} not recorded: ${(err as Error).message}`);
      return null;
    }
  }

  /** Disk-pressure evaluation on host-truth samples. System path: never throws. */
  async evaluateDisk(dockId: string, diskBytes: number): Promise<{ id: string } | null> {
    try {
      const [dock] = await this.db.select().from(docks).where(eq(docks.id, dockId)).limit(1);
      if (!dock) return null;
      const orgId = await this.orgForWorkspace(dock.workspaceId);
      if (!orgId) return null;
      const capacity = dock.diskGiB * 1024 ** 3;
      const dockName = dock.name ?? dock.id;
      const ratio = diskBytes / capacity;
      if (ratio < DISK_REARM_RATIO) {
        await this.clearEdges(orgId, [`disk_warning:${dockId}`, `disk_full:${dockId}`]);
        return null;
      }
      const pct = Math.round(ratio * 100);
      if (ratio >= DISK_FULL_RATIO) {
        const [latest] = await this.db
          .select({ status: snapshots.status })
          .from(snapshots)
          .where(eq(snapshots.dockId, dockId))
          .orderBy(desc(snapshots.createdAt))
          .limit(1);
        if (latest?.status !== 'failed') return null;
        const body = `${dockName} is out of disk (${pct}% of its ${dock.diskGiB} GiB disk) and its snapshots are failing. Free space or grow the disk.`;
        return await this.emit({
          type: 'disk_full',
          organizationId: orgId,
          workspaceId: dock.workspaceId,
          dockId,
          edgeKey: `disk_full:${dockId}`,
          dedupeKey: `disk_full:${dockId}`,
          title: 'Dock disk full',
          body,
          linkPath: `/docks/${dockId}`,
          template: 'disk_full',
          subject: `Dock disk full: ${dockName}`,
          context: { linkUrl: this.appUrl(`/docks/${dockId}`), dockName, detail: body },
        });
      }
      if (ratio >= DISK_WARNING_RATIO) {
        const body = `${dockName} crossed the disk warning line at ${pct}% of its ${dock.diskGiB} GiB disk.`;
        return await this.emit({
          type: 'disk_warning',
          organizationId: orgId,
          workspaceId: dock.workspaceId,
          dockId,
          edgeKey: `disk_warning:${dockId}`,
          dedupeKey: `disk_warning:${dockId}`,
          title: 'Dock disk almost full',
          body,
          linkPath: `/docks/${dockId}`,
          template: 'disk_warning',
          subject: `Dock disk almost full: ${dockName}`,
          context: { linkUrl: this.appUrl(`/docks/${dockId}`), dockName, detail: body },
        });
      }
      return null;
    } catch (err) {
      this.logger.warn(`Disk evaluation for dock ${dockId} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Outbox event plus inbox rows plus role-filtered email. Failures stay local. */
  private async fanOut(
    event: NotificationEvent,
    mail: { template: MailTemplate; subject: string; context: Omit<MailContext, 'subject'> },
  ): Promise<void> {
    try {
      const [orgPref] = await this.db
        .select()
        .from(notificationOrgPrefs)
        .where(and(eq(notificationOrgPrefs.organizationId, event.organizationId), eq(notificationOrgPrefs.alertType, event.type)))
        .limit(1);
      if (orgPref && !orgPref.enabled) return;
      const members = await this.db
        .select({ userId: organizationMembers.userId, email: users.email, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.organizationId, event.organizationId));
      const targets =
        NOTIFICATION_AUDIENCE[event.type] === 'billing'
          ? members.filter((m) => m.role === 'owner' || m.role === 'admin')
          : members;
      if (!targets.length) return;
      await this.db
        .insert(notificationInbox)
        .values(targets.map((t) => ({ eventId: event.id, userId: t.userId })))
        .onConflictDoNothing({ target: [notificationInbox.eventId, notificationInbox.userId] });
      const prefs = await this.db
        .select()
        .from(notificationUserPrefs)
        .where(
          and(
            inArray(notificationUserPrefs.userId, targets.map((t) => t.userId)),
            eq(notificationUserPrefs.alertType, event.type),
          ),
        );
      const mailOff = new Set(prefs.filter((p) => !p.emailEnabled).map((p) => p.userId));
      const results = await Promise.allSettled(
        targets
          .filter((t) => !mailOff.has(t.userId))
          .map((t) => this.mail.send({ to: t.email, subject: mail.subject, template: mail.template, context: mail.context })),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) this.logger.warn(`Notification ${event.id} email fan-out had ${failed} failures`);
    } catch (err) {
      this.logger.warn(`Notification ${event.id} not fanned out: ${(err as Error).message}`);
    }
  }

  private async clearEdges(organizationId: string, edgeKeys: string[]): Promise<void> {
    for (const edgeKey of edgeKeys) {
      try {
        await this.db
          .delete(notificationEdges)
          .where(and(eq(notificationEdges.organizationId, organizationId), eq(notificationEdges.edgeKey, edgeKey)));
      } catch (err) {
        this.logger.warn(`Edge ${edgeKey} not cleared: ${(err as Error).message}`);
      }
    }
  }

  /** Plan retention window backing the kept-disk copy; null when unresolvable. */
  private async retentionDaysFor(organizationId: string): Promise<number | null> {
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
    if (!sub) return null;
    const [plan] = await this.db
      .select({ retentionDays: billingPlans.retentionDays })
      .from(billingPlans)
      .where(and(eq(billingPlans.plan, sub.plan), eq(billingPlans.version, sub.planVersion)))
      .limit(1);
    return plan?.retentionDays ?? null;
  }

  private async orgForWorkspace(workspaceId: string): Promise<string | null> {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    return ws?.organizationId ?? null;
  }

  private appUrl(path: string): string {
    return `${this.config.get<string>('APP_URL') || publicAppUrl(this.config)}${path}`;
  }

  private checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) throw validationError('Limit must be an integer between 1 and 100');
    return Math.min(limit, 100);
  }
}
