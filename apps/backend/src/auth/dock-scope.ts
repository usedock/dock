import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface DockScope {
  orgId?: string;
}

const storage = new AsyncLocalStorage<DockScope>();

/** Opens a per-request scope the guard fills in for dock-bound keys. */
export function dockScopeMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  storage.run({}, next);
}

/** Test and non-HTTP helper: runs fn inside a scope. */
export function runInDockScope<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Pins the request to one org; false when no scope is open so callers can fail closed. */
export function bindDockScope(orgId: string): boolean {
  const scope = storage.getStore();
  if (!scope) return false;
  scope.orgId = orgId;
  return true;
}

/** True unless the request is pinned to a different org. */
export function inDockScope(orgId: string): boolean {
  const pinned = storage.getStore()?.orgId;
  return !pinned || pinned === orgId;
}

/** Narrows a membership org list to the pinned org, if any. */
export function scopeOrgIds(orgIds: string[]): string[] {
  const pinned = storage.getStore()?.orgId;
  return pinned ? orgIds.filter((id) => id === pinned) : orgIds;
}
