import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { InboxQuery, PreferencesQuery, UpdateOrgPreferenceDto, UpdatePersonalPreferenceDto } from './dto/notifications.dto';

/** Human notification inbox and preferences. Org writes need a browser session. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  listInbox(@CurrentUser() user: RequestUser, @Query() query: InboxQuery) {
    return this.notifications.listInbox(user.id, query.cursor, query.limit);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() user: RequestUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: RequestUser, @Query() query: PreferencesQuery) {
    return this.notifications.getPreferences(user.id, query.organizationId);
  }

  @Put('preferences/organization')
  updateOrgPreference(@CurrentUser() user: RequestUser, @Body() dto: UpdateOrgPreferenceDto) {
    return this.notifications.updateOrgPreference(user, dto.organizationId, dto.type, dto.enabled);
  }

  @Put('preferences/personal')
  updatePersonalPreference(@CurrentUser() user: RequestUser, @Body() dto: UpdatePersonalPreferenceDto) {
    return this.notifications.updatePersonalPreference(user.id, dto.type, dto.emailEnabled);
  }
}
