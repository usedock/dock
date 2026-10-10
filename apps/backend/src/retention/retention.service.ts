import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { newUuid } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import {
  docks,
  operations,
  retentionPolicies,
  snapshots,
  templates,
  workspaces,
} from '../database/schema';
import { COMPUTE_PROVIDER, type ComputeProvider } from '../docks/compute.provider';
import { deleteGenerations, orphanedGenerations } from './generation-cleanup';
import { OrganizationsService, type OrgTx } from '../organizations/organizations.service';

/** Exact phrase required to turn the retention switch on. */
export const RETENTION_CONFIRM_PHRASE = 'delete archived dock data';

export class SessionRequiredException extends ForbiddenException {
  constructor() {
    super({ code: 'session_required', message: 'This action requires an interactive browser session' });
  }
}

export class ConfirmRequiredException extends BadRequestException {
  constructor() {
    super({ code: 'confirm_required', message: 'Exact confirmation phrase required' });
  }
}

export class TemplatesBlockedException extends ForbiddenException {
  constructor() {
    super({ code: 'zdr_blocks_templates', message: 'Templates are disabled while retention is enabled' });
  }
}

/**
 * Per-organization retention switch. Reads are member-visible (service keys
 * included); writes need an interactive browser session plus owner role.
 */
@Injectable()
export class RetentionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async getPolicy(callerId: string, orgId: string): Promise<{ enabled: boolean }> {
    await this.orgs.requireMembership(orgId, callerId);
    return { enabled: await this.policyOn(this.db, orgId) };
  }

  /** Service-to-service read without membership checks. */
  async policyOn(executor: OrgTx, orgId: string): Promise<boolean> {
    const [row] = await executor
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.organizationId, orgId))
      .limit(1);
    return row?.zdrEnabled ?? false;
  }

  async updatePolicy(
    caller: RequestUser,
    orgId: string,
    enabled: boolean,
    confirmation?: string,
  ): Promise<{ enabled: boolean }> {
    if (caller.isInteractive !== true) throw new SessionRequiredException();
    await this.orgs.requireMembership(orgId, caller.id, 'owner');
    if (!enabled) {
      await this.upsert(this.db, orgId, false);
      return { enabled: false };
    }
    if (await this.policyOn(this.db, orgId)) return { enabled: true };
    if (confirmation !== RETENTION_CONFIRM_PHRASE) throw new ConfirmRequiredException();
    const doomed: Array<{ dockId: string; generations: string[] }> = [];
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`retention:${orgId}`}))`);
      await this.upsert(tx, orgId, true);
      const wsRows = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.organizationId, orgId));
      const wsIds = wsRows.map((w) => w.id);
      if (wsIds.length) {
        const archived = await tx
          .select()
          .from(docks)
          .where(and(inArray(docks.workspaceId, wsIds), eq(docks.state, 'archived')));
        for (const dock of archived) {
          doomed.push({ dockId: dock.id, generations: await orphanedGenerations(tx, dock.id, orgId) });
          await this.deleteDockRows(tx, orgId, dock.id);
        }
      }
      const tpls = await tx
        .select()
        .from(templates)
        .where(eq(templates.organizationId, orgId));
      for (const tpl of tpls) {
        const [op] = await tx
          .insert(operations)
          .values({
            displayId: `op_${newUuid().replace(/-/g, '').slice(0, 20)}`,
            organizationId: orgId,
            targetType: 'template',
            targetId: tpl.id,
            status: 'pending',
          })
          .returning();
        if (tpl.storeSnapshotId) doomed.push({ dockId: `template:${tpl.id}`, generations: [tpl.storeSnapshotId] });
        await tx.delete(templates).where(eq(templates.id, tpl.id));
        await tx
          .update(operations)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(operations.id, op.id));
      }
    });
    const provider = this.moduleRef.get<ComputeProvider>(COMPUTE_PROVIDER, { strict: false });
    for (const d of doomed) await deleteGenerations(provider, d.dockId, d.generations);
    return { enabled: true };
  }

  private async upsert(executor: OrgTx, orgId: string, on: boolean): Promise<void> {
    await executor
      .insert(retentionPolicies)
      .values({ organizationId: orgId, zdrEnabled: on })
      .onConflictDoUpdate({
        target: retentionPolicies.organizationId,
        set: { zdrEnabled: on, updatedAt: new Date() },
      });
  }

  private async deleteDockRows(tx: OrgTx, orgId: string, dockId: string): Promise<void> {
    const [op] = await tx
      .insert(operations)
      .values({
        displayId: `op_${newUuid().replace(/-/g, '').slice(0, 20)}`,
        organizationId: orgId,
        targetType: 'dock',
        targetId: dockId,
        status: 'pending',
      })
      .returning();
    await tx.delete(snapshots).where(eq(snapshots.dockId, dockId));
    await tx.delete(docks).where(eq(docks.id, dockId));
    await tx
      .update(operations)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(operations.id, op.id));
  }
}
