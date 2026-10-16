/** Registered by docklets that confine a dock on resume; older ones ignore the allowlist there. */
export const EGRESS_ON_RESUME = 'egress-on-resume';

/** Registered by docklets that verify an uploaded disk's sha256 and size and bound its decompressed size before booting it. */
export const VERIFIED_IMPORTS = 'verified-imports';

/** Registered by gVisor hosts that can capture a dock's work directory as state.tar.zst for export. */
export const WORK_EXPORT = 'work-export';
