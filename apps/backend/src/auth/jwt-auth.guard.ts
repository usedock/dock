import {
  CanActivate,
  ExecutionContext,
  GoneException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { AccountClosedException, AccountClosureService } from '../account-closure/account-closure.service';
import { API_KEY_PREFIX } from '../api-keys/api-keys.service';
import { hashToken } from '../crypto/tokens';
import { DB, Db } from '../database/database.module';
import { apiKeys, docks, users, workspaces } from '../database/schema';
import { ALLOW_CLOSED_KEY } from '../common/allow-closed.decorator';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { ALLOW_DOCK_KEY, DockKeyForbiddenException } from '../common/allow-dock-key.decorator';
import { bindDockScope } from './dock-scope';
import { BetterAuthService } from './better-auth/better-auth.service';

export interface RequestUser {
  id: string;
  email: string;
  emailVerified: boolean;
  /** True for browser-session JWTs, false for dock_ service keys. Unset in older callers. */
  isInteractive?: boolean;
  /** Set when the key is bound to one dock; the request is confined to that dock's org. */
  dockId?: string;
  dockOrgId?: string;
}

const unauthorized = (message: string) =>
  new UnauthorizedException({ code: 'unauthorized', message });

/** Global guard: API key, Better Auth cookie session, or @Public(). */
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
    private readonly closures: AccountClosureService,
    private readonly betterAuth: BetterAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: RequestUser;
      params?: Record<string, string | undefined>;
    }>();
    const header = req.headers.authorization ?? '';
    const [type, token] = header.split(' ');
    if (type !== 'Bearer' || !token) {
      const sessionUser = await this.betterAuth.getSessionUser(req.headers.cookie);
      if (!sessionUser) throw unauthorized('Missing or invalid authorization header');
      await this.enforceClosure(context, sessionUser.id);
      req.user = sessionUser;
      return true;
    }
    const user = await this.userForApiKey(token);
    if (!user) throw unauthorized('Invalid or expired token');
    await this.enforceClosure(context, user.id);
    this.enforceDockKeyPolicy(context, user, req.params?.id);
    req.user = user;
    return true;
  }

  /** Dock-bound keys reach only @AllowDockKey() routes, and only for their own dock. */
  private enforceDockKeyPolicy(context: ExecutionContext, user: RequestUser, dockParam?: string): void {
    if (!user.dockId) return;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_DOCK_KEY, [context.getHandler(), context.getClass()]);
    if (!allowed || dockParam !== user.dockId) throw new DockKeyForbiddenException();
  }

  /**
   * Closed accounts reach only @AllowClosed() routes; erased accounts get
   * 410 everywhere. Purge-due closures are swept lazily inside guardCheck.
   */
  private async enforceClosure(context: ExecutionContext, userId: string): Promise<void> {
    const state = await this.closures.guardCheck(userId);
    if (state === 'ok') return;
    if (state === 'erased') throw new GoneException({ code: 'account_closed', message: 'Account data is gone' });
    const allowClosed = this.reflector.getAllAndOverride<boolean>(ALLOW_CLOSED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowClosed) throw new AccountClosedException();
  }

  private async orgForDock(dockId: string): Promise<string | null> {
    const rows = await this.db
      .select({ organizationId: workspaces.organizationId })
      .from(docks)
      .innerJoin(workspaces, eq(workspaces.id, docks.workspaceId))
      .where(eq(docks.id, dockId))
      .limit(1);
    return rows[0]?.organizationId ?? null;
  }

  /** API-key fallback: valid, unrevoked, unexpired keys hydrate the same user. Never throws. */
  private async userForApiKey(raw: string): Promise<RequestUser | null> {
    try {
      if (!raw.startsWith(API_KEY_PREFIX)) return null;
      const keyRows = await this.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashToken(raw)))
        .limit(1);
      const key = keyRows[0] ?? null;
      if (!key || key.revokedAt) return null;
      if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;
      const userRows = await this.db
        .select()
        .from(users)
        .where(eq(users.id, key.userId))
        .limit(1);
      const user = userRows[0] ?? null;
      if (!user) return null;
      try {
        await this.db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, key.id));
      } catch {
        // Bookkeeping must never fail authentication.
      }
      const base = { id: user.id, email: user.email, emailVerified: user.emailVerified, isInteractive: false };
      if (!key.dockId) return base;
      // Dock-bound keys act only inside their dock's org; no resolvable org means no auth.
      const orgId = await this.orgForDock(key.dockId);
      if (!orgId || !bindDockScope(orgId)) return null;
      return { ...base, dockId: key.dockId, dockOrgId: orgId };
    } catch {
      return null;
    }
  }
}
