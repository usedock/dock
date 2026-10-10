import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { InvitationsService } from './invitations.service';

/** Admin invitation management plus the invitee's own view; dock-bound keys never reach these. */
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get('organizations/:id/invitations')
  list(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.invitations.list(user.id, id);
  }

  @Delete('organizations/:id/invitations/:invitationId')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitations.revoke(user.id, id, invitationId);
  }

  @Post('organizations/:id/invitations/:invitationId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitations.resend(user.id, id, invitationId);
  }

  @Get('me/invitations')
  listMine(@CurrentUser() user: RequestUser) {
    return this.invitations.listForUser(user);
  }

  @Post('me/invitations/:invitationId/accept')
  @HttpCode(HttpStatus.OK)
  acceptMine(@CurrentUser() user: RequestUser, @Param('invitationId') invitationId: string) {
    return this.invitations.accept(user, { id: invitationId });
  }

  @Post('me/invitations/:invitationId/decline')
  @HttpCode(HttpStatus.OK)
  declineMine(@CurrentUser() user: RequestUser, @Param('invitationId') invitationId: string) {
    return this.invitations.decline(user, { id: invitationId });
  }

  @Get('invitations/:token')
  preview(@CurrentUser() user: RequestUser, @Param('token') token: string) {
    return this.invitations.preview(user, token);
  }

  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: RequestUser, @Param('token') token: string) {
    return this.invitations.accept(user, { token });
  }

  @Post('invitations/:token/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: RequestUser, @Param('token') token: string) {
    return this.invitations.decline(user, { token });
  }
}
