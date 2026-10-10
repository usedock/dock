import { Body, Controller, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AllowClosed } from '../common/allow-closed.decorator';
import { AccountClosureService } from './account-closure.service';
import { EraseAccountDto } from './dto/erase-account.dto';

/** Whole-account close/reopen/erase. Browser session only; never cached. */
@Controller()
export class AccountClosureController {
  constructor(private readonly closure: AccountClosureService) {}

  @Post('account/close')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  close(@CurrentUser() user: RequestUser) {
    return this.closure.close(user);
  }

  @Post('account/reopen')
  @HttpCode(HttpStatus.OK)
  @AllowClosed()
  @Header('Cache-Control', 'no-store')
  reopen(@CurrentUser() user: RequestUser) {
    return this.closure.reopen(user.id);
  }
  @Post('account/erase')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowClosed()
  @Header('Cache-Control', 'no-store')
  erase(@CurrentUser() user: RequestUser, @Body() dto: EraseAccountDto) {
    return this.closure.erase(user, dto.confirmation);
  }
}
