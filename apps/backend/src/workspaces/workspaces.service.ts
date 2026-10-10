import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { docks, workspaces, type Workspace } from '../database/schema';
import { candidateSlug, randomSuffix, SLUG_RE } from '../organizations/slug';
import {
  OrganizationNotFoundException,
  OrganizationsService,
  SlugTakenException,
  isUniqueViolation,
  type OrgTx,
} from '../organizations/organizations.service';

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkspaceNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'workspace_not_found', message: 'Workspace not found' });
  }
}

/**
 * Workspaces live inside exactly one organization. Every route authorizes
 * through the parent org membership; item routes hide org existence as 404.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
  ) {}

  async listByOrg(callerId: string, orgId: string): Promise<Workspace[]> {
    await this.orgs.requireMembership(orgId, callerId);
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.organizationId, orgId))
      .orderBy(asc(workspaces.createdAt));
    if (rows.length) return rows;
    try {
      const [created] = await this.db
        .insert(workspaces)
        .values({ organizationId: orgId, name: 'Default', slug: 'default' })
        .returning();
      return [created];
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.organizationId, orgId))
        .orderBy(asc(workspaces.createdAt));
    }
  }

  async create(callerId: string, orgId: string, input: CreateWorkspaceInput): Promise<Workspace> {
    const name = input.name?.trim() ?? '';
    if (!name || name.length > 100) {
      throw new BadRequestException({ code: 'validation_error', message: 'Name must be 1-100 characters' });
    }
    const explicit = input.slug?.trim() || undefined;
    if (explicit && !SLUG_RE.test(explicit)) {
      throw new BadRequestException({
        code: 'validation_error',
        message: 'Slug must be 3-63 lowercase letters, digits, or hyphens',
      });
    }
    await this.orgs.requireMembership(orgId, callerId, 'admin');
    const base = explicit ?? candidateSlug(name);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ws:${orgId}`}))`);
      const slug = await this.claimWorkspaceSlug(tx, orgId, base, !!explicit);
      try {
        const [ws] = await tx
          .insert(workspaces)
          .values({ organizationId: orgId, name, slug })
          .returning();
        return ws;
      } catch (err) {
        if (isUniqueViolation(err)) throw new SlugTakenException();
        throw err;
      }
    });
  }

  async getById(callerId: string, id: string): Promise<Workspace> {
    if (!UUID_RE.test(id)) throw new WorkspaceNotFoundException();
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (!ws) throw new WorkspaceNotFoundException();
    try {
      await this.orgs.requireMembership(ws.organizationId, callerId);
    } catch (err) {
      if (err instanceof OrganizationNotFoundException) throw new WorkspaceNotFoundException();
      throw err;
    }
    return ws;
  }

  async update(callerId: string, id: string, patch: UpdateWorkspaceInput): Promise<Workspace> {
    const ws = await this.getById(callerId, id);
    await this.orgs.requireMembership(ws.organizationId, callerId, 'admin');
    const set: Partial<typeof workspaces.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 100) {
        throw new BadRequestException({ code: 'validation_error', message: 'Name must be 1-100 characters' });
      }
      set.name = name;
    }
    if (patch.slug !== undefined) {
      const slug = patch.slug.trim();
      if (!SLUG_RE.test(slug)) {
        throw new BadRequestException({
          code: 'validation_error',
          message: 'Slug must be 3-63 lowercase letters, digits, or hyphens',
        });
      }
      if (slug !== ws.slug && (await this.workspaceSlugTaken(ws.organizationId, slug))) {
        throw new SlugTakenException();
      }
      set.slug = slug;
    }
    try {
      const [updated] = await this.db
        .update(workspaces)
        .set(set)
        .where(eq(workspaces.id, id))
        .returning();
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlugTakenException();
      throw err;
    }
  }

  /** Refuses an organization's last workspace; its docks would cascade-delete. */
  async remove(callerId: string, id: string): Promise<{ deleted: boolean }> {
    const ws = await this.getById(callerId, id);
    await this.orgs.requireMembership(ws.organizationId, callerId, 'admin');
    const siblings = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.organizationId, ws.organizationId));
    if (siblings.length <= 1) {
      throw new BadRequestException({
        code: 'validation_error',
        message: 'Cannot delete the only workspace',
      });
    }
    // Cascading dock rows would orphan their machines on the hosts.
    const [dock] = await this.db.select({ id: docks.id }).from(docks).where(eq(docks.workspaceId, id)).limit(1);
    if (dock) {
      throw new ConflictException({
        code: 'workspace_not_empty',
        message: 'Delete the docks in this workspace first',
      });
    }
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
    return { deleted: true };
  }

  private async claimWorkspaceSlug(
    tx: OrgTx,
    orgId: string,
    base: string,
    explicit: boolean,
  ): Promise<string> {
    if (explicit) {
      if (await this.txSlugTaken(tx, orgId, base)) throw new SlugTakenException();
      return base;
    }
    if (!(await this.txSlugTaken(tx, orgId, base))) return base;
    const retry = `${base.slice(0, 56)}-${randomSuffix()}`;
    if (!(await this.txSlugTaken(tx, orgId, retry))) return retry;
    throw new SlugTakenException();
  }

  private async txSlugTaken(tx: OrgTx, orgId: string, slug: string): Promise<boolean> {
    const rows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.organizationId, orgId), eq(workspaces.slug, slug)))
      .limit(1);
    return !!rows[0];
  }

  private async workspaceSlugTaken(orgId: string, slug: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.organizationId, orgId), eq(workspaces.slug, slug)))
      .limit(1);
    return !!rows[0];
  }
}
