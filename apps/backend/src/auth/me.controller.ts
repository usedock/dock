import { ConflictException, Controller, Delete, Get, Inject, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { account } from '../database/schema';
import { DB, Db } from '../database/database.module';
import { isInstanceAdmin } from '../config/instance';
import { CurrentUser } from './current-user.decorator';
import { RequestUser } from './jwt-auth.guard';

@Controller('me')
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getMine(@CurrentUser() user: RequestUser) {
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      providers: await this.linkedProviders(user.id),
      instanceAdmin: isInstanceAdmin(this.config, user),
    };
  }

  @Get('connections')
  async listConnections(@CurrentUser() user: RequestUser) {
    const rows = await this.db
      .select({
        provider: account.providerId,
        identifier: account.accountId,
        linkedAt: account.createdAt,
      })
      .from(account)
      .where(eq(account.userId, user.id));
    return {
      connections: rows.map((row) => ({
        id: `${row.provider}:${row.identifier}`,
        provider: row.provider,
        identifier: row.identifier,
        primary: row.provider === 'credential',
        linkedAt: row.linkedAt.toISOString(),
      })),
    };
  }

  @Delete('connections/:id')
  async removeConnection(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const [provider, ...rest] = id.split(':');
    const accountId = rest.join(':');
    if (!provider || !accountId || provider === 'credential') {
      return { removed: false };
    }
    // Rows are locked so concurrent unlinks cannot each see another method remaining.
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ provider: account.providerId, accountId: account.accountId, password: account.password })
        .from(account)
        .where(eq(account.userId, user.id))
        .for('update');
      const target = rows.find((row) => row.provider === provider && row.accountId === accountId);
      if (!target) return { removed: false };
      // A credential row without a password is not a usable login method.
      const remaining = rows.filter((row) => row !== target && (row.provider !== 'credential' || !!row.password));
      if (remaining.length === 0) {
        throw new ConflictException({ code: 'last_login_method', message: 'Cannot remove your last login method' });
      }
      await tx
        .delete(account)
        .where(and(eq(account.userId, user.id), eq(account.providerId, provider), eq(account.accountId, accountId)));
      return { removed: true };
    });
  }

  private async linkedProviders(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ provider: account.providerId })
      .from(account)
      .where(eq(account.userId, userId));
    return rows.map((row) => row.provider);
  }
}
