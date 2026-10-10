import { ConflictException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';

export class SubscriptionRequiredException extends HttpException {
  constructor() {
    super(
      { code: 'subscription_required', message: 'An active subscription is required to start compute' },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export class ConcurrencyExceededException extends ConflictException {
  constructor() {
    super({ code: 'concurrency_exceeded', message: 'Concurrent dock limit for this plan is reached' });
  }
}

export class FastRunConcurrencyExceededException extends ConflictException {
  constructor() {
    super({ code: 'fast_run_concurrency_exceeded', message: 'Concurrent Fast Run limit for this plan is reached' });
  }
}

export class BudgetExceededException extends ForbiddenException {
  constructor() {
    super({ code: 'budget_exceeded', message: 'Monthly budget is exhausted' });
  }
}
