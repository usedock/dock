import { ForbiddenException, SetMetadata } from '@nestjs/common';

/** Metadata key for routes a dock-bound API key may call, on its own dock only. */
export const ALLOW_DOCK_KEY = 'allowDockKey';

/** Opt-in for dock-bound keys; only for routes whose `:id` is the dock id, which the guard requires to be the key's own dock. */
export const AllowDockKey = () => SetMetadata(ALLOW_DOCK_KEY, true);

export class DockKeyForbiddenException extends ForbiddenException {
  constructor() {
    super({ code: 'dock_key_forbidden', message: 'Dock-bound API keys cannot perform this action' });
  }
}
