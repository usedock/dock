import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { ConnectorsService } from './connectors.service';
import { ConnectConnectorDto, SetWebhookDto } from './dto/connect-connector.dto';

/** Workspace tool connections: admins connect and disconnect, members list; tokens are never returned. */
@Controller('workspaces/:workspaceId/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param('workspaceId') workspaceId: string) {
    return this.connectors.list(user.id, workspaceId);
  }

  @Put(':kind')
  @HttpCode(HttpStatus.OK)
  connect(
    @CurrentUser() user: RequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('kind') kind: string,
    @Body() dto: ConnectConnectorDto,
  ) {
    return this.connectors.connect(user.id, workspaceId, kind, dto.token, dto.host);
  }

  @Put(':kind/webhook')
  @HttpCode(HttpStatus.OK)
  setWebhook(
    @CurrentUser() user: RequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('kind') kind: string,
    @Body() dto: SetWebhookDto,
  ) {
    return this.connectors.setWebhook(user.id, workspaceId, kind, dto);
  }

  @Delete(':kind')
  @HttpCode(HttpStatus.OK)
  disconnect(@CurrentUser() user: RequestUser, @Param('workspaceId') workspaceId: string, @Param('kind') kind: string) {
    return this.connectors.disconnect(user.id, workspaceId, kind);
  }
}
