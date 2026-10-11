import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { ConnectorRepoLinksService } from './connector-repo-links.service';
import { DeleteRepoLinkQuery, PutRepoLinkDto } from './dto/repo-link.dto';

/** Which GitHub repository a connector's triggered runs may open pull requests in; admins only. */
@Controller('workspaces/:workspaceId/connectors/:kind/repo-links')
export class ConnectorRepoLinksController {
  constructor(private readonly links: ConnectorRepoLinksService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param('workspaceId') workspaceId: string, @Param('kind') kind: string) {
    return this.links.list(user.id, workspaceId, kind);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  put(@CurrentUser() user: RequestUser, @Param('workspaceId') workspaceId: string, @Param('kind') kind: string, @Body() dto: PutRepoLinkDto) {
    return this.links.put(user.id, workspaceId, kind, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('workspaceId') workspaceId: string, @Param('kind') kind: string, @Query() query: DeleteRepoLinkQuery) {
    return this.links.remove(user.id, workspaceId, kind, query.scope);
  }
}
