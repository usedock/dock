import { SetMetadata } from '@nestjs/common';

/** Metadata key for routes reachable while the account is closed (reopen, erase). */
export const ALLOW_CLOSED_KEY = 'allowClosed';

/** Marks a handler reachable while the caller's account is closed. */
export const AllowClosed = () => SetMetadata(ALLOW_CLOSED_KEY, true);
