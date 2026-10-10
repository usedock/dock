import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser } from './jwt-auth.guard';

/** Handler parameter bound to the guard-populated request user. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    return ctx.switchToHttp().getRequest<{ user: RequestUser }>().user;
  },
);
