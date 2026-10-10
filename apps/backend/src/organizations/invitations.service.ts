import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { RequestUser } from '../auth/jwt-auth.guard';
import { hashToken, newToken } from '../crypto/tokens';
import { publicAppUrl } from '../config/instance';
import { DB, Db } from '../database/database.module';
import {
  organizationInvitations,
  organizationMembers,
  organizations,
  users,
  type OrgRole,
} from '../database/schema';
import { MailService } from '../mail/mail.service';
import {
  OrganizationNotFoundException,
  OrganizationsService,
  OrgTx,
  SeatsExceededException,
  lockOrg,
  pendingInvitation,
} from './organizations.service';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_ROLES: Record<string, true> = { owner: true, admin: true, member: true };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same body whether or not the email has an account, is already a member, or was just invited.
const INVITE_ACCEPTED = { status: 'accepted' } as const;

export interface InviteInput {
  userId?: string;
  email?: string;
  role?: OrgRole;
}

export interface InvitationView {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
  createdAt: Date;
}

export interface MyInvitationView {
  id: string;
  organizationName: string;
  role: OrgRole;
  expiresAt: Date;
}

/** One error for unknown, expired, revoked, consumed and not-addressed-to-you tokens. */
export class InvitationNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'invitation_not_found', message: 'Invitation is invalid or has expired' });
  }
}

function validation(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}

type Invitation = typeof organizationInvitations.$inferSelect;
type Lookup = { token: string } | { id: string };

/** Accept-required member invitations. Adding by email only ever creates one. */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async invite(callerId: string, orgId: string, input: InviteInput) {
    const role = input.role ?? 'member';
    if (!VALID_ROLES[role]) throw validation('Role must be owner, admin, or member');
    if (!input.userId && !input.email) throw validation('Provide userId or email');
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    if (role === 'owner') await this.orgs.requireMembership(orgId, callerId, 'owner');
    let email = input.email?.trim().toLowerCase() ?? '';
    if (input.userId) {
      const [user] = UUID_RE.test(input.userId)
        ? await this.db.select().from(users).where(eq(users.id, input.userId)).limit(1)
        : [];
      if (!user) throw new NotFoundException({ code: 'user_not_found', message: 'User not found' });
      email = user.email.toLowerCase();
    }
    const token = newToken();
    const orgName = await this.db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const org = await this.lockedOrg(tx, orgId);
      const members = await tx
        .select({ userId: organizationMembers.userId, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.organizationId, orgId));
      const pending = await tx.select().from(organizationInvitations).where(pendingInvitation(orgId));
      const others = pending.filter((p) => p.email !== email).length;
      // Same seat check for members, strangers and re-invites so a full org reveals nothing.
      if (members.length + others >= org.seats) throw new SeatsExceededException();
      if (members.some((m) => m.email.toLowerCase() === email)) return null;
      // Refreshing an owner invitation (even with a lower role) is an owner action.
      if (pending.some((p) => p.email === email && p.role === 'owner')) {
        await this.orgs.requireMembership(orgId, callerId, 'owner');
      }
      await this.upsertPending(tx, { orgId, email, role, token, invitedBy: callerId });
      return org.name;
    });
    if (orgName) this.sendInvite(email, orgName, role, token);
    return INVITE_ACCEPTED;
  }

  async list(callerId: string, orgId: string): Promise<InvitationView[]> {
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    const rows = await this.db
      .select()
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.organizationId, orgId),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.revokedAt),
        ),
      )
      .orderBy(desc(organizationInvitations.createdAt));
    return rows.map(toView);
  }

  async revoke(callerId: string, orgId: string, invitationId: string) {
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    if (!UUID_RE.test(invitationId)) throw new InvitationNotFoundException();
    return this.db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const rows = await tx
        .update(organizationInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, orgId),
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
          ),
        )
        .returning({ id: organizationInvitations.id });
      if (!rows[0]) throw new InvitationNotFoundException();
      return { revoked: true };
    });
  }

  /** Issues a fresh token and expiry; the old link stops working. */
  async resend(callerId: string, orgId: string, invitationId: string): Promise<InvitationView> {
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    if (!UUID_RE.test(invitationId)) throw new InvitationNotFoundException();
    const token = newToken();
    const result = await this.db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const org = await this.lockedOrg(tx, orgId);
      const [inv] = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, orgId),
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
          ),
        )
        .limit(1);
      if (!inv) throw new InvitationNotFoundException();
      if (inv.role === 'owner') await this.orgs.requireMembership(orgId, callerId, 'owner');
      const members = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, orgId));
      const pending = await tx.select().from(organizationInvitations).where(pendingInvitation(orgId));
      if (members.length + pending.filter((p) => p.id !== inv.id).length >= org.seats) {
        throw new SeatsExceededException();
      }
      const [updated] = await tx
        .update(organizationInvitations)
        .set({
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          invitedBy: callerId,
        })
        .where(eq(organizationInvitations.id, inv.id))
        .returning();
      return { invitation: updated, orgName: org.name };
    });
    this.sendInvite(result.invitation.email, result.orgName, result.invitation.role, token);
    return toView(result.invitation);
  }

  /** Pending invitations addressed to the caller's verified email. */
  async listForUser(user: RequestUser): Promise<MyInvitationView[]> {
    if (!user.emailVerified) return [];
    return this.db
      .select({
        id: organizationInvitations.id,
        organizationName: organizations.name,
        role: organizationInvitations.role,
        expiresAt: organizationInvitations.expiresAt,
      })
      .from(organizationInvitations)
      .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
      .where(
        and(
          eq(organizationInvitations.email, user.email.trim().toLowerCase()),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.revokedAt),
          gt(organizationInvitations.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(organizationInvitations.createdAt));
  }

  /** Read-only preview for the accept page; same guards as accepting. */
  async preview(user: RequestUser, token: string): Promise<MyInvitationView> {
    const inv = await this.findUsable(this.db, user, { token });
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, inv.organizationId))
      .limit(1);
    if (!org) throw new InvitationNotFoundException();
    return { id: inv.id, organizationName: org.name, role: inv.role, expiresAt: inv.expiresAt };
  }

  async accept(user: RequestUser, lookup: Lookup) {
    const first = await this.findUsable(this.db, user, lookup);
    return this.db.transaction(async (tx) => {
      await lockOrg(tx, first.organizationId);
      // Re-read under the lock: a concurrent revoke, accept or resend wins cleanly.
      const inv = await this.findUsable(tx, user, lookup);
      const org = await this.lockedOrg(tx, inv.organizationId);
      const [existing] = await tx
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, inv.organizationId),
            eq(organizationMembers.userId, user.id),
          ),
        )
        .limit(1);
      if (!existing) {
        const members = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(eq(organizationMembers.organizationId, inv.organizationId));
        // The invitation already holds its own seat, so only members are counted here.
        if (members.length >= org.seats) throw new SeatsExceededException();
        await tx
          .insert(organizationMembers)
          .values({ organizationId: inv.organizationId, userId: user.id, role: inv.role });
      }
      const consumed = await tx
        .update(organizationInvitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(organizationInvitations.id, inv.id), isNull(organizationInvitations.acceptedAt), isNull(organizationInvitations.revokedAt)))
        .returning({ id: organizationInvitations.id });
      if (!consumed[0]) throw new InvitationNotFoundException();
      return { organizationId: inv.organizationId, role: existing?.role ?? inv.role };
    });
  }

  async decline(user: RequestUser, lookup: Lookup) {
    const first = await this.findUsable(this.db, user, lookup);
    return this.db.transaction(async (tx) => {
      await lockOrg(tx, first.organizationId);
      const inv = await this.findUsable(tx, user, lookup);
      await tx
        .update(organizationInvitations)
        .set({ revokedAt: new Date() })
        .where(eq(organizationInvitations.id, inv.id));
      return { declined: true };
    });
  }

  private async findUsable(exec: OrgTx, user: RequestUser, lookup: Lookup): Promise<Invitation> {
    if (!user.emailVerified) throw new InvitationNotFoundException();
    let condition;
    if ('token' in lookup) {
      condition = eq(organizationInvitations.tokenHash, hashToken(lookup.token));
    } else {
      if (!UUID_RE.test(lookup.id)) throw new InvitationNotFoundException();
      condition = eq(organizationInvitations.id, lookup.id);
    }
    const [inv] = await exec.select().from(organizationInvitations).where(condition).limit(1);
    if (
      !inv ||
      inv.acceptedAt ||
      inv.revokedAt ||
      inv.expiresAt.getTime() <= Date.now() ||
      inv.email !== user.email.trim().toLowerCase()
    ) {
      throw new InvitationNotFoundException();
    }
    return inv;
  }

  private async lockedOrg(tx: OrgTx, orgId: string) {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new OrganizationNotFoundException();
    return org;
  }

  private async upsertPending(
    tx: OrgTx,
    input: { orgId: string; email: string; role: OrgRole; token: string; invitedBy: string },
  ): Promise<void> {
    const fields = {
      role: input.role,
      tokenHash: hashToken(input.token),
      invitedBy: input.invitedBy,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    };
    const updated = await tx
      .update(organizationInvitations)
      .set(fields)
      .where(
        and(
          eq(organizationInvitations.organizationId, input.orgId),
          eq(organizationInvitations.email, input.email),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.revokedAt),
        ),
      )
      .returning({ id: organizationInvitations.id });
    if (updated[0]) return;
    await tx
      .insert(organizationInvitations)
      .values({ organizationId: input.orgId, email: input.email, ...fields });
  }

  /** Detached so delivery time never differs between invited and already-member emails. */
  private sendInvite(email: string, orgName: string, role: OrgRole, token: string): void {
    void this.mail.send({
      to: email,
      subject: `You are invited to ${orgName} on Dock`,
      template: 'organization-invitation',
      context: {
        email,
        orgName,
        role,
        inviteUrl: `${publicAppUrl(this.config)}/invitations/${token}`,
      },
    });
  }
}

function toView(inv: Invitation): InvitationView {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  };
}
