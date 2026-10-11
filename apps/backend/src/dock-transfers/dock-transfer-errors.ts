import { BadRequestException, ConflictException, HttpException, HttpStatus, NotFoundException, PayloadTooLargeException } from '@nestjs/common';

/** Declared or uploaded size above what the dock's disk can hold. */
export class ImportTooLargeException extends PayloadTooLargeException {
  constructor(message: string) {
    super({ code: 'import_too_large', message });
  }
}

/** The uploaded object is not the file the importer declared. */
export class ImportChecksumMismatchException extends BadRequestException {
  constructor(message: string) {
    super({ code: 'import_checksum_mismatch', message });
  }
}

/** Imports and exports need a microVM host; gVisor keeps only the work directory. */
export class RuntimeUnsupportedException extends ConflictException {
  constructor(message = 'Importing and exporting a dock needs a microVM host') {
    super({ code: 'runtime_unsupported', message });
  }
}

export class ImportNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'import_not_found', message: 'Import not found' });
  }
}

export class ExportNotFoundException extends NotFoundException {
  constructor() {
    super({ code: 'export_not_found', message: 'Export not found' });
  }
}

/** A Range past the end of the export; the controller answers it with a Content-Range carrying the size so a client restarts. */
export class RangeNotSatisfiableException extends HttpException {
  readonly size: number;

  constructor(size: number) {
    super({ code: 'range_not_satisfiable', message: 'Range is not satisfiable' }, HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    this.size = size;
  }
}

/** Importing would end in a refused boot: no host confines the default Environment's egress allowlist on resume. */
export class ImportEgressUnsupportedException extends ConflictException {
  constructor() {
    super({ code: 'import_egress_unsupported', message: 'No host that verifies imports supports the default environment egress allowlist; upgrade the docklets' });
  }
}

/** Too many open uploads or live exports at once; each holds object storage. */
export class TransferLimitException extends HttpException {
  constructor(code: 'import_limit_reached' | 'export_limit_reached', message: string) {
    super({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Too many proxied parts in flight; each is buffered in memory, so the caller retries shortly. */
export class PartUploadBusyException extends HttpException {
  constructor(message: string) {
    super({ code: 'part_upload_busy', message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Export codes carried in the `error` field of a failed export. */
export const EXPORT_BASE_UNSUPPORTED = 'export_base_unsupported';
export const EXPORT_FAILED = 'export_failed';
export const EXPORT_INTERRUPTED = 'export_interrupted';
