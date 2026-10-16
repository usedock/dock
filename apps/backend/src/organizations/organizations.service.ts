import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import {
  billingPlans,
  environmentVersions,
  environments,
  organizationInvitations,
  organizationMembers,
  organizations,
  subscriptions,
  users,
  workspaces,
  type Organization,
  type OrgRole,
} from '../database/schema';
import { inDockScope } from '../auth/dock-scope';
import { candidateSlug, personalSlug, randomSuffix, SLUG_RE } from './slug';

/** Query executor shared by Db handles and transaction callbacks. */
export interface OrgTx {
  insert: Db['insert'];
  select: Db['select'];
  update: Db['update'];
  delete: Db['delete'];
  execute: Db['execute'];
}

export interface OrganizationWithRole extends Organization {
  role: OrgRole;
}

export interface MemberView {
  userId: string;
  email: string;
  role: OrgRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  seats?: number;
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  seats?: number;
}

const VALID_ROLES: Record<string, true> = { owner: true, admin: true, member: true };
const DEFAULT_SEATS = 5;
const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OrganizationNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'organization_not_found', message: 'Organization not found' });
  }
}

export class MemberNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'member_not_found', message: 'Organization member not found' });
  }
}

export class SlugTakenException extends ConflictException {
  constructor() {
    super({ code: 'slug_taken', message: 'Slug is already taken' });
  }
}
/** Matches raw pg errors and drizzle-wrapped ones (code hides on cause). */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
export class SeatsExceededException extends ConflictException {
  constructor() {
    super({ code: 'seats_exceeded', message: 'Organization has no free seats' });
  }
}

class CannotRemoveOwnerException extends BadRequestException {
  constructor() {
    super({ code: 'cannot_remove_owner', message: 'Organization must keep at least one owner' });
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: 'validation_error', message });
}


/** Unexpired, unconsumed invitations for an org; each one holds a seat. */
export function pendingInvitation(orgId: string) {
  return and(
    eq(organizationInvitations.organizationId, orgId),
    isNull(organizationInvitations.acceptedAt),
    isNull(organizationInvitations.revokedAt),
    gt(organizationInvitations.expiresAt, sql`now()`),
  );
}

/** Serializes seat/slug mutations for one org. Unique constraints decide races. */
export async function lockOrg(tx: OrgTx, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`org:${orgId}`}))`);
}

/**
 * Organizations own members and workspaces. Membership is the seat unit and
 * the only authorization input; non-members always see 404, never 403.
 */
@Injectable()
export class OrganizationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Base environment plus empty v1, inside the org-create transaction. */
  private async provisionBaseEnv(tx: OrgTx, orgId: string): Promise<void> {
    const [env] = await tx
      .insert(environments)
      .values({ organizationId: orgId, name: 'base', isDefault: true })
      .returning();
    await tx
      .insert(environmentVersions)
      .values({ environmentId: env.id, version: 1, repos: [], envVars: {}, secretFiles: [] });
  }

  /** Personal org + owner membership + default workspace, inside the caller's tx. */
  async provisionPersonalOrg(
    tx: OrgTx,
    input: { userId: string; email: string; name?: string },
  ): Promise<Organization> {
    const label = input.name?.trim() || input.email.split('@')[0] || 'Personal';
    const name = `${label}'s org`.slice(0, 100);
    const [org] = await tx
      .insert(organizations)
      .values({ name, slug: personalSlug(input.email), seats: DEFAULT_SEATS })
      .returning();
    await tx
      .insert(organizationMembers)
      .values({ organizationId: org.id, userId: input.userId, role: 'owner' });
    await tx
      .insert(workspaces)
      .values({ organizationId: org.id, name: 'Default', slug: 'default' });
    await this.provisionBaseEnv(tx, org.id);
    await this.provisionSubscription(tx, org.id);
    return org;
  }

  /** Developer subscription pinned to the current plan version, inside the org-create tx. */
  private async provisionSubscription(tx: OrgTx, orgId: string): Promise<void> {
    const [plan] = await tx
      .select({ version: billingPlans.version })
      .from(billingPlans)
      .where(and(eq(billingPlans.plan, 'developer'), eq(billingPlans.isCurrent, true)))
      .limit(1);
    await tx.insert(subscriptions).values({
      organizationId: orgId,
      plan: 'developer',
      planVersion: plan?.version ?? 1,
      status: 'active',
    });
  }
  /** Idempotent backfill for users predating organizations. Returns the new org or null. */
  async ensureUserHasOrg(userId: string): Promise<Organization | null> {
    const existing = await this.db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .limit(1);
    if (existing[0]) return null;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`org-backfill:${userId}`}))`);
      const recheck = await tx
        .select({ organizationId: organizationMembers.organizationId })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, userId))
        .limit(1);
      if (recheck[0]) return null;
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return null;
      return this.provisionPersonalOrg(tx, { userId, email: user.email });
    });
  }

  async listMine(userId: string): Promise<OrganizationWithRole[]> {
    await this.ensureUserHasOrg(userId);
    const memberships = (
      await this.db.select().from(organizationMembers).where(eq(organizationMembers.userId, userId))
    ).filter((m) => inDockScope(m.organizationId));
    const out: OrganizationWithRole[] = [];
    for (const m of memberships) {
      const [org] = await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, m.organizationId))
        .limit(1);
      if (org) out.push({ ...org, role: m.role });
    }
    return out;
  }

  async create(callerId: string, input: CreateOrganizationInput): Promise<OrganizationWithRole> {
    const name = input.name?.trim() ?? '';
    if (!name || name.length > 100) throw validationError('Name must be 1-100 characters');
    const seats = input.seats ?? DEFAULT_SEATS;
    if (!Number.isInteger(seats) || seats < 1) {
      throw validationError('Seats must be an integer of at least 1');
    }
    const explicit = input.slug?.trim() || undefined;
    if (explicit && !SLUG_RE.test(explicit)) {
      throw validationError('Slug must be 3-63 lowercase letters, digits, or hyphens');
    }
    const base = explicit ?? candidateSlug(name);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`org-create:${base}`}))`);
      const slug = await this.claimOrgSlug(tx, base, !!explicit);
      try {
        const [org] = await tx
          .insert(organizations)
          .values({ name, slug, seats })
          .returning();
        await tx
          .insert(organizationMembers)
          .values({ organizationId: org.id, userId: callerId, role: 'owner' });
        await tx
          .insert(workspaces)
          .values({ organizationId: org.id, name: 'Default', slug: 'default' });
        await this.provisionBaseEnv(tx, org.id);
        await this.provisionSubscription(tx, org.id);
        return { ...org, role: 'owner' as const };
      } catch (err) {
        if (isUniqueViolation(err)) throw new SlugTakenException();
        throw err;
      }
    });
  }

  async getById(callerId: string, orgId: string): Promise<OrganizationWithRole> {
    const membership = await this.requireMembership(orgId, callerId);
    const [org] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new OrganizationNotFoundException();
    return { ...org, role: membership.role };
  }

  async update(
    callerId: string,
    orgId: string,
    patch: UpdateOrganizationInput,
  ): Promise<Organization> {
    await this.requireMembership(orgId, callerId, 'admin');
    return this.db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
      if (!org) throw new OrganizationNotFoundException();
      const set: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name || name.length > 100) throw validationError('Name must be 1-100 characters');
        set.name = name;
      }
      if (patch.slug !== undefined) {
        const slug = patch.slug.trim();
        if (!SLUG_RE.test(slug)) {
          throw validationError('Slug must be 3-63 lowercase letters, digits, or hyphens');
        }
        if (slug !== org.slug) {
          if (await this.orgSlugTaken(tx, slug)) throw new SlugTakenException();
          set.slug = slug;
        }
      }
      if (patch.seats !== undefined) {
        if (!Number.isInteger(patch.seats) || patch.seats < 1) {
          throw validationError('Seats must be an integer of at least 1');
        }
        const members = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(eq(organizationMembers.organizationId, orgId));
        const pending = await tx
          .select({ id: organizationInvitations.id })
          .from(organizationInvitations)
          .where(pendingInvitation(orgId));
        if (patch.seats < members.length + pending.length) {
          throw validationError('Seats cannot be below members plus pending invitations');
        }
        set.seats = patch.seats;
      }
      try {
        const [updated] = await tx
          .update(organizations)
          .set(set)
          .where(eq(organizations.id, orgId))
          .returning();
        return updated;
      } catch (err) {
        if (isUniqueViolation(err)) throw new SlugTakenException();
        throw err;
      }
    });
  }

  /** Owner-only. Workspaces and memberships cascade via foreign keys. */
  async remove(callerId: string, orgId: string): Promise<{ deleted: boolean }> {
    await this.requireMembership(orgId, callerId, 'owner');
    await this.db.delete(organizations).where(eq(organizations.id, orgId));
    return { deleted: true };
  }

  async listMembers(callerId: string, orgId: string): Promise<MemberView[]> {
    await this.requireMembership(orgId, callerId);
    const members = await this.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, orgId))
      .orderBy(asc(organizationMembers.createdAt));
    const emails = await this.emailsFor(members.map((m) => m.userId));
    return members.map((m) => ({
      userId: m.userId,
      email: emails.get(m.userId) ?? '',
      role: m.role,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  /**
   * Role writes and owner-count checks must share one locked transaction;
   * otherwise two concurrent demotions can each see "2 owners" and leave zero.
   */
  async updateMemberRole(callerId: string, orgId: string, targetUserId: string, role: OrgRole) {
    if (!VALID_ROLES[role]) throw validationError('Role must be owner, admin, or member');
    await this.requireMembership(orgId, callerId, 'admin');
    return this.db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const [target] = await tx
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, targetUserId),
          ),
        )
        .limit(1);
      if (!target) throw new MemberNotFoundException();
      if (target.role === 'owner' || role === 'owner') {
        await this.requireMembership(orgId, callerId, 'owner');
      }
      if (target.role === 'owner' && role !== 'owner' && (await this.ownerCount(tx, orgId)) <= 1) {
        throw new CannotRemoveOwnerException();
      }
      const [updated] = await tx
        .update(organizationMembers)
        .set({ role, updatedAt: new Date() })
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, targetUserId),
          ),
        )
        .returning();
      return updated;
    });
  }

  /** Same locked-transaction guard as updateMemberRole; see its comment. */
  async removeMember(callerId: string, orgId: string, targetUserId: string) {
    await this.requireMembership(orgId, callerId, 'admin');
    return this.db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const [target] = await tx
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, targetUserId),
          ),
        )
        .limit(1);
      if (!target) throw new MemberNotFoundException();
      if (target.role === 'owner') {
        await this.requireMembership(orgId, callerId, 'owner');
        if ((await this.ownerCount(tx, orgId)) <= 1) throw new CannotRemoveOwnerException();
      }
      await tx
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, targetUserId),
          ),
        );
      return { removed: true };
    });
  }

  /**
   * Membership gate for org and workspace routes. Unknown orgs, malformed
   * ids, and non-members all read as 404 so callers learn nothing.
   */
  async requireMembership(orgId: string, userId: string, minRole: OrgRole = 'member') {
    if (!UUID_RE.test(orgId) || !inDockScope(orgId)) throw new OrganizationNotFoundException();
    const [membership] = await this.db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!membership) throw new OrganizationNotFoundException();
    if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Insufficient organization role' });
    }
    return membership;
  }

  private async claimOrgSlug(tx: OrgTx, base: string, explicit: boolean): Promise<string> {
    if (explicit) {
      if (await this.orgSlugTaken(tx, base)) throw new SlugTakenException();
      return base;
    }
    if (!(await this.orgSlugTaken(tx, base))) return base;
    const retry = `${base.slice(0, 56)}-${randomSuffix()}`;
    if (!(await this.orgSlugTaken(tx, retry))) return retry;
    throw new SlugTakenException();
  }

  private async orgSlugTaken(tx: OrgTx, slug: string): Promise<boolean> {
    const rows = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return !!rows[0];
  }

  private async ownerCount(executor: OrgTx, orgId: string): Promise<number> {
    const rows = await executor
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, orgId));
    return rows.filter((r) => r.role === 'owner').length;
  }

  private async emailsFor(userIds: string[]): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const rows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    return new Map(rows.map((r) => [r.id, r.email]));
  }
}
