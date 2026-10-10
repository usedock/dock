import { Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { HostsService } from './hosts.service';

/** Host fleet view and credential recovery, restricted to instance admins. */
@Controller('hosts')
export class HostsController {
  constructor(private readonly hosts: HostsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.hosts.listForAdmin(user);
  }

  @Get(':id')
  getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.hosts.getForAdmin(user, id);
  }

  /** Replaces a host's fleet credential; the new one is shown once and must be installed on the host. */
  @Post(':id/reset-credential')
  @HttpCode(HttpStatus.OK)
  resetCredential(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    if (user.isInteractive !== true) {
      throw new ForbiddenException({ code: 'session_required', message: 'This action requires an interactive browser session' });
    }
    return this.hosts.resetCredential(user, id);
  }
}
