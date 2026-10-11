import { BILLING_ERROR_CODES, DOCK_ERROR_CODES, codeForStatus } from './codes';

describe('codeForStatus', () => {
  it.each([
    [400, 'validation_error'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'payload_too_large'],
    [429, 'rate_limited'],
    [500, 'internal_error'],
    [502, 'bad_gateway'],
    [503, 'service_unavailable'],
  ] as Array<[number, string]>)('maps %i to %s', (status, expected) => {
    expect(codeForStatus(status)).toBe(expected);
  });

  it.each([200, 201, 418, 599])('falls back to request_failed for %i', (status) => {
    expect(codeForStatus(status)).toBe('request_failed');
  });
});

describe('DOCK_ERROR_CODES', () => {
  it('registers every dock lifecycle code with its HTTP status', () => {
    expect(DOCK_ERROR_CODES).toEqual({
      dock_not_found: 404,
      snapshot_not_found: 404,
      template_not_found: 404,
      template_limit_reached: 409,
      snapshot_in_use: 409,
      idempotency_in_progress: 409,
      idempotency_key_reused: 409,
      confirm_required: 400,
      image_unknown: 400,
      image_unavailable: 400,
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
    });
  });
});

describe('BILLING_ERROR_CODES', () => {
  it('registers every billing code with its HTTP status', () => {
    expect(BILLING_ERROR_CODES).toEqual({
      subscription_required: 402,
      concurrency_exceeded: 409,
      budget_exceeded: 403,
      invalid_signature: 401,
      invoice_not_found: 404,
    });
  });
});
