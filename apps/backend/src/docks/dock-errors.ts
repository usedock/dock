import { BadRequestException, ForbiddenException, ConflictException, GatewayTimeoutException, HttpException, HttpStatus, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

/** Dock item routes hide foreign existence as 404. */
export class DockNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'dock_not_found', message: 'Dock not found' });
  }
}

/** Destructive calls without an exact X-Confirm-Delete header. */
export class ConfirmRequiredException extends BadRequestException {
  constructor() {
    super({ code: 'confirm_required', message: 'X-Confirm-Delete must equal the target id' });
  }
}

/** Template reads for foreign, missing, or deleted names. */
export class TemplateNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'template_not_found', message: 'Template not found' });
  }
}

/** Placement found no online host with capacity for the required CPU family. */
export class NoHostCapacityException extends ServiceUnavailableException {
  constructor() {
    super({ code: 'no_host_capacity', message: 'No host has capacity for this dock' });
  }
}
/** Hosts exist but none has room for the requested cpus and memory. */
export class CapacityExhaustedException extends ServiceUnavailableException {
  constructor() {
    super({ code: 'capacity_exhausted', message: 'No host has room for the requested cpus and memory' });
  }
}

/** Dock names are unique per workspace. */
export class DockNameTakenException extends ConflictException {
  constructor(name: string) {
    super({ code: 'dock_name_taken', message: `A dock named ${name} already exists in this workspace` });
  }
}

/** Exec needs a live, metered machine. */
export class DockNotRunningException extends ConflictException {
  constructor(state: string) {
    super({ code: 'dock_not_running', message: `Dock is ${state}; commands run only on ready docks` });
  }
}

/** The machine has no guest exec agent (booted before exec, or a run-owned dock). */
export class ExecUnavailableException extends ConflictException {
  constructor(message = 'Exec is unavailable on this dock; stop and resume it to enable exec') {
    super({ code: 'exec_unavailable', message });
  }
}

/** The command outlived its timeoutSeconds and was killed. */
export class ExecTimeoutException extends GatewayTimeoutException {
  constructor(seconds: number) {
    super({ code: 'exec_timeout', message: `Command exceeded ${seconds}s and was killed` });
  }
}

/** A replayed command already ran but its large result was not retained; never re-run it. */
export class ExecResultExpiredException extends ConflictException {
  constructor() {
    super({ code: 'exec_result_expired', message: 'Command already ran; result not retained' });
  }
}

/** The host could not take or finish the command; safe to retry later. */
export class ExecFailedException extends ServiceUnavailableException {
  constructor(code: 'exec_busy' | 'exec_failed', message: string) {
    super({ code, message });
  }
}

/** Per-dock or per-caller exec limits were hit. */
export class ExecRateLimitedException extends HttpException {
  constructor() {
    super({ code: 'rate_limited', message: 'Too many commands, try again later' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Per-dock or per-user open terminal caps were hit. */
export class TerminalLimitException extends HttpException {
  constructor() {
    super({ code: 'rate_limited', message: 'Too many open terminals; close one and try again' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Template names: 2-64 chars, lowercase/digits/dash/underscore, padded ends. */
export const TEMPLATE_RE = /^[a-z0-9]([a-z0-9-_]{1,63}[a-z0-9])$/;

export class SnapshotInUseException extends ConflictException {
  constructor(message = 'Snapshot is still referenced by a newer snapshot') {
    // 409: another incremental snapshot, a template, or an active restore still depends on it.
    super({ code: 'snapshot_in_use', message });
  }
}

/** A ready template points at a snapshot row that no longer exists. */
export class TemplateSourceMissingException extends ConflictException {
  constructor(name: string) {
    super({ code: 'template_source_missing', message: `Template ${name} references a snapshot that no longer exists` });
  }
}

/** Deleting a dock needs its creator or an org admin. */
export class DockDeleteForbiddenException extends ForbiddenException {
  constructor() {
    super({ code: 'dock_delete_forbidden', message: "Only the dock's creator or an org admin can delete it" });
  }
}
