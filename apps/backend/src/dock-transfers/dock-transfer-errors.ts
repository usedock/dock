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

/** Too many open uploads or live exports at once; each holds object storage. */
export class TransferLimitException extends HttpException {
  constructor(code: 'import_limit_reached' | 'export_limit_reached', message: string) {
    super({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Export codes carried in the `error` field of a failed export. */
export const EXPORT_BASE_UNSUPPORTED = 'export_base_unsupported';
export const EXPORT_FAILED = 'export_failed';
export const EXPORT_INTERRUPTED = 'export_interrupted';
