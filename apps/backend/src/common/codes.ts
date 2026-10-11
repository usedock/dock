const STATUS_CODES: Record<number, string> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'bad_gateway',
  503: 'service_unavailable',
};

/** Stable machine-readable code for an HTTP status. */
export function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? 'request_failed';
}

/** Code → HTTP status for the dock lifecycle domain. Test-enforced in codes.spec.ts. */
export const DOCK_ERROR_CODES: Record<string, number> = {
  dock_not_found: 404,
  snapshot_not_found: 404,
  template_not_found: 404,
  template_limit_reached: 409,
  snapshot_in_use: 409,
  idempotency_in_progress: 409,
  idempotency_key_reused: 409,
  confirm_required: 400,
  session_required: 403,
  zdr_blocks_templates: 403,
  account_closed: 403,
  operation_not_found: 404,
  environment_not_found: 404,
  environment_name_taken: 409,
  dock_not_running: 409,
  exec_unavailable: 409,
  exec_timeout: 504,
  exec_busy: 503,
  exec_failed: 503,
  dock_name_taken: 409,
  capacity_exhausted: 503,
};

/** Code → HTTP status for the billing domain. Stable across plan repricing. */
export const BILLING_ERROR_CODES: Record<string, number> = {
  subscription_required: 402,
  concurrency_exceeded: 409,
  budget_exceeded: 403,
  invalid_signature: 401,
  invoice_not_found: 404,
};
