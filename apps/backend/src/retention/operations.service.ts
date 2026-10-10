import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { operations, type OperationStatus, type OperationTarget } from '../database/schema';
import type { Operation as OperationRow } from '../database/schema/operations';
import { DB, Db } from '../database/database.module';
import { OrganizationNotFoundException, OrganizationsService } from '../organizations/organizations.service';
import { newUuid } from '../crypto/tokens';

export interface OperationView {
  id: string;
  targetType: OperationTarget;
  targetId: string;
  status: OperationStatus;
}

export class OperationNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'operation_not_found', message: 'Operation not found' });
  }
}

function view(row: OperationRow): OperationView {
  return { id: row.displayId, targetType: row.targetType, targetId: row.targetId, status: row.status };
}

/** Pollable receipts for accepted async work. Uncancellable, immutable history. */
@Injectable()
export class OperationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgs: OrganizationsService,
  ) {}

  // Reuse assumes one op-creating action per target type; a second concurrent action would share the op.
  /** A retry reuses the target's blocked operation instead of stacking a new one. */
  async create(organizationId: string, targetType: OperationTarget, targetId: string): Promise<OperationView> {
    const [blocked] = await this.db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, organizationId),
          eq(operations.targetType, targetType),
          eq(operations.targetId, targetId),
          eq(operations.status, 'blocked'),
        ),
      )
      .limit(1);
    if (blocked) {
      const [reused] = await this.db
        .update(operations)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(and(eq(operations.id, blocked.id), eq(operations.status, 'blocked')))
        .returning();
      if (reused) return view(reused);
    }
    const displayId = `op_${newUuid().replace(/-/g, '').slice(0, 20)}`;
    const [row] = await this.db
      .insert(operations)
      .values({ displayId, organizationId, targetType, targetId, status: 'pending' })
      .returning();
    return view(row);
  }

  async complete(displayId: string): Promise<OperationView> {
    const [row] = await this.db
      .update(operations)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(operations.displayId, displayId))
      .returning();
    if (!row) throw new OperationNotFoundException();
    return view(row);
  }

  /** Marks an operation whose work could not finish; the status has no failed value. */
  async block(displayId: string): Promise<void> {
    await this.db.update(operations).set({ status: 'blocked', updatedAt: new Date() }).where(eq(operations.displayId, displayId));
  }

  /** Foreign or unscoped operations read as 404, never 403. */
  async get(callerId: string, displayId: string): Promise<OperationView> {
    const [row] = await this.db
      .select()
      .from(operations)
      .where(eq(operations.displayId, displayId))
      .limit(1);
    if (!row?.organizationId) throw new OperationNotFoundException();
    try {
      await this.orgs.requireMembership(row.organizationId, callerId);
    } catch (err) {
      if (err instanceof OrganizationNotFoundException) throw new OperationNotFoundException();
      throw err;
    }
    return view(row);
  }
}
