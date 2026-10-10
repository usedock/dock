import { ConflictException, ForbiddenException, GoneException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { DB, Db } from '../database/database.module';
import {
  account,
  accountClosures,
  apiKeys,
  docks,
  type Dock,
  organizationMembers,
  profiles,
  session,
  snapshots,
  sshKeys,
  templates,
  users,
  workspaces,
} from '../database/schema';
import { MeteringService } from '../metering/metering.service';
import { COMPUTE_PROVIDER, type ComputeProvider } from '../docks/compute.provider';
import { RUNNABLE_STATES, DocksService } from '../docks/docks.service';
import { lockOrg } from '../organizations/organizations.service';
import { MailService } from '../mail/mail.service';
import { SshConnectionRegistry } from './ssh-connection-registry';
import { ConfirmRequiredException, SessionRequiredException } from '../retention/retention.service';

/** Exact phrase required for immediate erasure. */
export const ERASE_CONFIRM_PHRASE = 'erase my account data';

/** Closed-but-recoverable window. */
export const CLOSE_GRACE_MS = 30 * 24 * 3600 * 1000;

export class AccountClosedException extends ForbiddenException {
  constructor() {
    super({ code: 'account_closed', message: 'Account is closed' });
  }
}

export class AccountErasedException extends GoneException {
  constructor() {
    super({ code: 'account_closed', message: 'Account data is gone' });
  }
}

export class SoleOwnerOfSharedOrgException extends ConflictException {
  constructor() {
    super({
      code: 'sole_owner_of_shared_org',
      message: 'Transfer ownership or remove the other members of your shared organizations before closing your account',
    });
  }
}

/** Runnable docks the user created; the only docks closure may stop in shared orgs. */
export function createdRunningDocks(userId: string) {
  return and(eq(docks.createdBy, userId), inArray(docks.state, RUNNABLE_STATES));
}

/**
 * Whole-account destructive lifecycle. Close archives running docks,
 * revokes credentials, and schedules purge in 30 days; erase additionally
 * scrubs identity at once and can never be reopened.
 */
@Injectable()
export class AccountClosureService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly docks: DocksService,
    private readonly mail: MailService,
    @Inject(COMPUTE_PROVIDER) private readonly provider: ComputeProvider,
    private readonly metering: MeteringService,
    private readonly sshConnections: SshConnectionRegistry,
  ) {}

  private readonly logger = new Logger(AccountClosureService.name);

  /** Guard input: open, closed (allow-listed routes only), or erased (410). */
  async guardCheck(userId: string): Promise<'ok' | 'closed' | 'erased'> {
    const [row] = await this.db
      .select()
      .from(accountClosures)
      .where(eq(accountClosures.userId, userId))
      .limit(1);
    if (!row) return 'ok';
    if (row.state === 'erased') return 'erased';
    if (row.purgeAt && row.purgeAt.getTime() <= Date.now() && !row.purgedAt) {
      await this.purgeDueForUser(userId);
    }
    return 'closed';
  }

  async close(caller: RequestUser): Promise<{ closed: boolean; purgeAt: Date | null }> {
    if (caller.isInteractive !== true) throw new SessionRequiredException();
    const [existing] = await this.db
      .select()
      .from(accountClosures)
      .where(eq(accountClosures.userId, caller.id))
      .limit(1);
    if (existing?.state === 'erased') throw new AccountErasedException();
    if (existing) return { closed: true, purgeAt: existing.purgeAt };
    const owned = await this.ownedOrgs(caller.id);
    if (owned.blocking.length) throw new SoleOwnerOfSharedOrgException();
    await this.archiveRunning(caller.id, owned.solo);
    await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.userId, caller.id), isNull(apiKeys.revokedAt)));
    // SSH keys authenticate outside the HTTP guard, so they must go with the account.
    await this.db.delete(sshKeys).where(eq(sshKeys.userId, caller.id));
    await this.db.delete(session).where(eq(session.userId, caller.id));
    const purgeAt = new Date(Date.now() + CLOSE_GRACE_MS);
    await this.db.insert(accountClosures).values({
      userId: caller.id,
      state: 'closed',
      purgeAt,
      subscriptionCanceledAt: new Date(),
    });
    // Registry is per process; other instances rely on the per-session requireOpenAccount check.
    this.sshConnections.disconnectUser(caller.id);
    void this.mail.send({
      to: caller.email,
      subject: 'Your Dock account is closed',
      template: 'account-closed',
      context: { email: caller.email, purgeDate: purgeAt.toISOString().slice(0, 10) },
    });
    return { closed: true, purgeAt };
  }

  async reopen(callerId: string): Promise<{ reopened: boolean }> {
    const [row] = await this.db
      .select()
      .from(accountClosures)
      .where(eq(accountClosures.userId, callerId))
      .limit(1);
    if (!row) return { reopened: false };
    if (row.state === 'erased') throw new AccountErasedException();
    if (row.purgeAt && row.purgeAt.getTime() <= Date.now() && !row.purgedAt) {
      await this.purgeDueForUser(callerId);
    }
    await this.db.delete(accountClosures).where(eq(accountClosures.userId, callerId));
    return { reopened: true };
  }

  async erase(caller: RequestUser, confirmation?: string): Promise<{ erased: boolean }> {
    if (caller.isInteractive !== true) throw new SessionRequiredException();
    const [existing] = await this.db
      .select()
      .from(accountClosures)
      .where(eq(accountClosures.userId, caller.id))
      .limit(1);
    if (existing?.state === 'erased') throw new AccountErasedException();
    if (confirmation !== ERASE_CONFIRM_PHRASE) throw new ConfirmRequiredException();
    const { blocking, solo, shared } = await this.ownedOrgs(caller.id);
    if (blocking.length) throw new SoleOwnerOfSharedOrgException();
    // Locked re-checks run before anything is stopped so a late 409 leaves docks untouched.
    const stillShared: string[] = [];
    for (const orgId of shared) {
      if (await this.checkShared(caller.id, orgId)) solo.push(orgId);
      else stillShared.push(orgId);
    }
    await this.archiveRunning(caller.id, solo);
    for (const orgId of stillShared) {
      if (await this.leaveSharedOrg(caller.id, orgId)) solo.push(orgId);
    }
    await this.deleteUserDocks(caller.id, solo);
    await this.db.delete(sshKeys).where(eq(sshKeys.userId, caller.id));
    await this.db.delete(apiKeys).where(eq(apiKeys.userId, caller.id));
    await this.db.delete(session).where(eq(session.userId, caller.id));
    await this.db.delete(account).where(eq(account.userId, caller.id));
    await this.db.delete(profiles).where(eq(profiles.userId, caller.id));
    // Scrub identity on the users row itself: erase must free the email for
    // reuse and stop returning it from any surviving FK join, not just the
    // satellite tables deleted above.
    await this.db
      .update(users)
      .set({
        email: `erased-${caller.id}@erased.invalid`,
        name: '',
        image: null,
        emailVerified: false,
        emailVerifiedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, caller.id));
    await this.db
      .insert(accountClosures)
      .values({
        userId: caller.id,
        state: 'erased',
        purgeAt: null,
        purgedAt: new Date(),
        subscriptionCanceledAt: new Date(),
      })
      .onConflictDoUpdate({
        target: accountClosures.userId,
        set: { state: 'erased', purgeAt: null, purgedAt: new Date(), updatedAt: new Date() },
      });
    this.sshConnections.disconnectUser(caller.id);
    return { erased: true };
  }

  /** Sweeps past-due closures. Returns the number purged. */
  async purgeDue(): Promise<{ purged: number }> {
    const now = new Date();
    const rows = await this.db.select().from(accountClosures);
    let purged = 0;
    for (const row of rows) {
      if (row.state !== 'closed' || !row.purgeAt || row.purgeAt.getTime() > now.getTime() || row.purgedAt) {
        continue;
      }
      await this.purgeDueForUser(row.userId);
      purged += 1;
    }
    return { purged };
  }

  async purgeDueForUser(userId: string): Promise<void> {
    await this.deleteUserDocks(userId, (await this.ownedOrgs(userId)).solo);
    await this.db
      .update(accountClosures)
      .set({ purgedAt: new Date(), updatedAt: new Date() })
      .where(eq(accountClosures.userId, userId));
  }

  /**
   * Stops docks the user created, plus every runnable dock in orgs only they
   * populate (createdBy can be null or a former member there). Other members'
   * docks in shared orgs are never touched.
   */
  private async archiveRunning(userId: string, soloOrgIds: string[]): Promise<void> {
    const ids = new Set<string>();
    const own = await this.db.select({ id: docks.id }).from(docks).where(createdRunningDocks(userId));
    for (const r of own) ids.add(r.id);
    if (soloOrgIds.length) {
      const wsRows = await this.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(inArray(workspaces.organizationId, soloOrgIds));
      const wsIds = wsRows.map((w) => w.id);
      if (wsIds.length) {
        const rows = await this.db
          .select({ id: docks.id })
          .from(docks)
          .where(and(inArray(docks.workspaceId, wsIds), inArray(docks.state, RUNNABLE_STATES)));
        for (const r of rows) ids.add(r.id);
      }
    }
    for (const id of ids) {
      try {
        await this.docks.stop(userId, id);
      } catch {
        // A refused stop leaves the dock running; closure still proceeds.
      }
    }
  }

  /** Under the org lock: 'solo' when only this user remains, 'blocked' when leaving would strand other members. */
  private async lockedOrgState(tx: Parameters<typeof lockOrg>[0], userId: string, orgId: string): Promise<'solo' | 'blocked' | 'shared'> {
    await lockOrg(tx, orgId);
    const members = await tx
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, orgId));
    if (members.length === 1 && members[0].userId === userId) return 'solo';
    const owners = members.filter((m) => m.role === 'owner');
    return owners.length === 1 && owners[0].userId === userId ? 'blocked' : 'shared';
  }

  /** Locked check only; true when a concurrent erase left this user alone in the org. */
  private async checkShared(userId: string, orgId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const state = await this.lockedOrgState(tx, userId, orgId);
      if (state === 'blocked') throw new SoleOwnerOfSharedOrgException();
      return state === 'solo';
    });
  }

  /** Drops the membership under the org lock; true means the org is now solo and must be torn down instead. */
  private async leaveSharedOrg(userId: string, orgId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const state = await this.lockedOrgState(tx, userId, orgId);
      if (state === 'blocked') throw new SoleOwnerOfSharedOrgException();
      if (state === 'solo') return true;
      await tx
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)));
      return false;
    });
  }

  /**
   * Tears down every dock, snapshot and template in orgs the user alone populates.
   * Rows go under the org lock in a short transaction; slow provider calls run after commit.
   */
  private async deleteUserDocks(userId: string, orgIds: string[]): Promise<void> {
    for (const orgId of orgIds) {
      const doomed = await this.db.transaction(async (tx) => {
        const out = { docks: [] as Dock[], snapshotGens: [] as Array<{ id: string | null; dockId: string; hostId: string | null }>, templateGens: [] as Array<string | null> };
        if ((await this.lockedOrgState(tx, userId, orgId)) !== 'solo') return out;
        const wsRows = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.organizationId, orgId));
        const wsIds = wsRows.map((w) => w.id);
        if (wsIds.length) {
          const dockRows = await tx.select().from(docks).where(inArray(docks.workspaceId, wsIds));
          for (const dock of dockRows) {
            const snaps = await tx
              .select({ storeSnapshotId: snapshots.storeSnapshotId })
              .from(snapshots)
              .where(eq(snapshots.dockId, dock.id));
            out.docks.push(dock);
            for (const snap of snaps) out.snapshotGens.push({ id: snap.storeSnapshotId, dockId: dock.id, hostId: dock.hostId ?? null });
            await this.metering.closeWindowsForDock(dock.id, undefined, tx);
            await tx.delete(snapshots).where(eq(snapshots.dockId, dock.id));
            await tx.delete(docks).where(eq(docks.id, dock.id));
          }
        }
        const tpls = await tx
          .select({ storeSnapshotId: templates.storeSnapshotId })
          .from(templates)
          .where(eq(templates.organizationId, orgId));
        out.templateGens = tpls.map((t) => t.storeSnapshotId);
        await tx.delete(templates).where(eq(templates.organizationId, orgId));
        return out;
      });
      for (const dock of doomed.docks) {
        await this.bestEffort('destroy dock', { dockId: dock.id, hostId: dock.hostId ?? null, generationId: null }, () => this.provider.destroyBacking(dock));
      }
      for (const gen of doomed.snapshotGens) await this.deleteGeneration(gen.id, { dockId: gen.dockId, hostId: gen.hostId });
      for (const id of doomed.templateGens) await this.deleteGeneration(id, { dockId: null, hostId: null });
    }
  }

  private async deleteGeneration(id: string | null, ctx: { dockId: string | null; hostId: string | null }): Promise<void> {
    if (id) await this.bestEffort('delete generation', { ...ctx, generationId: id }, () => this.provider.deleteBacking(id));
  }

  /** Teardown must not block closure; failures are logged with ids so an operator can retry by hand. */
  private async bestEffort(
    what: string,
    ctx: { dockId: string | null; hostId: string | null; generationId: string | null },
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(
        `Account teardown failed to ${what}: dock=${ctx.dockId ?? 'none'} host=${ctx.hostId ?? 'none'} generation=${ctx.generationId ?? 'none'}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** solo: only member; shared: other members exist; blocking: shared and the user is the sole owner. */
  private async ownedOrgs(userId: string): Promise<{ solo: string[]; shared: string[]; blocking: string[] }> {
    const rows = await this.db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    const solo: string[] = [];
    const shared: string[] = [];
    const blocking: string[] = [];
    for (const orgId of new Set(rows.map((r) => r.organizationId))) {
      const members = await this.db
        .select({ userId: organizationMembers.userId, role: organizationMembers.role })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, orgId));
      if (members.length === 1 && members[0].userId === userId) {
        solo.push(orgId);
        continue;
      }
      shared.push(orgId);
      const owners = members.filter((m) => m.role === 'owner');
      if (owners.length === 1 && owners[0].userId === userId) blocking.push(orgId);
    }
    return { solo, shared, blocking };
  }
}
