import { Logger } from '@nestjs/common';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import type { Db } from '../database/database.module';
import { snapshots, templates } from '../database/schema';
import type { OrgTx } from '../organizations/organizations.service';

type Executor = Db | OrgTx;

/**
 * Generations held only by this dock's snapshot rows. Skips any still used by a
 * template or by another snapshot row (store_snapshot_id is not unique).
 * `purgedOrgId` names an org whose templates are being deleted in the same step.
 */
export async function orphanedGenerations(executor: Executor, dockId: string, purgedOrgId?: string): Promise<string[]> {
  const rows = await executor
    .select({ id: snapshots.id, storeSnapshotId: snapshots.storeSnapshotId })
    .from(snapshots)
    .where(eq(snapshots.dockId, dockId));
  const gens = [...new Set(rows.map((r) => r.storeSnapshotId).filter((g): g is string => !!g))];
  if (!gens.length) return [];
  const used = new Set<string>();
  const tplConds = [inArray(templates.storeSnapshotId, gens), inArray(templates.snapshotRef, rows.map((r) => r.id))];
  const tpls = await executor
    .select({ snapshotRef: templates.snapshotRef, storeSnapshotId: templates.storeSnapshotId })
    .from(templates)
    .where(purgedOrgId ? and(or(...tplConds), ne(templates.organizationId, purgedOrgId)) : or(...tplConds));
  for (const t of tpls) {
    if (t.storeSnapshotId) {
      used.add(t.storeSnapshotId);
      continue;
    }
    // A template with its own generation does not depend on the referenced row.
    const ref = rows.find((r) => r.id === t.snapshotRef);
    if (ref?.storeSnapshotId) used.add(ref.storeSnapshotId);
  }
  const others = await executor
    .select({ storeSnapshotId: snapshots.storeSnapshotId })
    .from(snapshots)
    .where(and(inArray(snapshots.storeSnapshotId, gens), ne(snapshots.dockId, dockId)));
  for (const o of others) if (o.storeSnapshotId) used.add(o.storeSnapshotId);
  return gens.filter((g) => !used.has(g));
}

/** Best effort: failures are logged and never block the caller. */
export async function deleteGenerations(
  provider: { deleteBacking(id: string): Promise<void> },
  dockId: string,
  generations: string[],
): Promise<void> {
  for (const generationId of generations) {
    try {
      await provider.deleteBacking(generationId);
    } catch (err) {
      new Logger('GenerationCleanup').error(
        `Failed to delete generation ${generationId} of dock ${dockId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
