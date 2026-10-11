import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../database/database.module';
import { docks, hostCommands, hostGenerations, snapshots, templates, type HostGeneration } from '../database/schema';

/** Command states in which a host is legitimately working on its payload. */
const ACTIVE_STATES = ['queued', 'claimed'] as const;

/**
 * Scopes generation objects to the calling host. A generation id is minted by
 * the host mid-capture, so a write binds it to that host's in-flight capture
 * and a read needs a generation the host owns or was explicitly told to load.
 */
@Injectable()
export class FleetObjectAccess {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Reads (get, list, presigned get): allowed for a snapshot of a dock placed on
   * this host, or when this host has a queued/claimed command naming the
   * generation (branch or resume placed elsewhere sends the host a load for it),
   * or when the generation is bound to this host's still-claimed capture.
   */
  async assertRead(hostId: string, snapshotId: string): Promise<void> {
    if ((await this.ownsStored(hostId, snapshotId)) || (await this.hasCommandFor(hostId, snapshotId))) return;
    // A host that may write a generation in its own claimed capture may read it back.
    const [bound] = await this.db.select().from(hostGenerations).where(eq(hostGenerations.generationId, snapshotId)).limit(1);
    if (bound) return this.assertBoundTo(hostId, bound);
    throw denied();
  }

  /**
   * Writes (put part, presigned put, delete): a generation id belongs to the
   * first host that writes it during its own claimed snapshot.create, and only
   * to that command. Recorded generations (snapshots, templates) are immutable
   * to hosts; only the backend prunes them.
   */
  async assertWrite(hostId: string, snapshotId: string): Promise<void> {
    const [bound] = await this.db.select().from(hostGenerations).where(eq(hostGenerations.generationId, snapshotId)).limit(1);
    if (bound) return this.assertBoundTo(hostId, bound);
    if (await this.recordedElsewhere(snapshotId)) throw denied();
    const [capture] = await this.db
      .select({ id: hostCommands.id })
      .from(hostCommands)
      .where(
        and(
          eq(hostCommands.hostId, hostId),
          eq(hostCommands.op, 'snapshot.create'),
          eq(hostCommands.state, 'claimed'),
          sql`${hostCommands.id} not in (select ${hostGenerations.commandId} from ${hostGenerations})`,
        ),
      )
      // A host runs captures serially, so the newest claim is the one in flight.
      .orderBy(desc(hostCommands.claimedAt))
      .limit(1);
    if (!capture) throw denied();
    const [created] = await this.db
      .insert(hostGenerations)
      .values({ generationId: snapshotId, hostId, commandId: capture.id })
      .onConflictDoNothing()
      .returning();
    if (created) return;
    // Lost a race for the id or the command: only the winner's own retry passes.
    const [winner] = await this.db.select().from(hostGenerations).where(eq(hostGenerations.generationId, snapshotId)).limit(1);
    if (!winner) throw denied();
    return this.assertBoundTo(hostId, winner);
  }

  private async assertBoundTo(hostId: string, bound: HostGeneration): Promise<void> {
    if (bound.hostId !== hostId) throw denied();
    const [command] = await this.db
      .select({ id: hostCommands.id })
      .from(hostCommands)
      .where(and(eq(hostCommands.id, bound.commandId), eq(hostCommands.hostId, hostId), eq(hostCommands.state, 'claimed')))
      .limit(1);
    if (!command) throw denied();
  }

  /** True when a snapshot row with this generation belongs to a dock placed on the host. */
  private async ownsStored(hostId: string, snapshotId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: snapshots.id })
      .from(snapshots)
      .innerJoin(docks, eq(docks.id, snapshots.dockId))
      .where(and(eq(snapshots.storeSnapshotId, snapshotId), eq(docks.hostId, hostId)))
      .limit(1);
    return Boolean(row);
  }

  private async hasCommandFor(hostId: string, snapshotId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: hostCommands.id })
      .from(hostCommands)
      .where(
        and(
          eq(hostCommands.hostId, hostId),
          inArray(hostCommands.state, [...ACTIVE_STATES]),
          sql`${hostCommands.payload}->>'snapshotId' = ${snapshotId}`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Any stored snapshot or template already records this generation. */
  private async recordedElsewhere(snapshotId: string): Promise<boolean> {
    const [snap] = await this.db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.storeSnapshotId, snapshotId)).limit(1);
    if (snap) return true;
    const [tpl] = await this.db.select({ id: templates.id }).from(templates).where(eq(templates.storeSnapshotId, snapshotId)).limit(1);
    return Boolean(tpl);
  }
}

function denied(): ForbiddenException {
  return new ForbiddenException({ code: 'generation_forbidden', message: 'Generation is not available to this host' });
}
