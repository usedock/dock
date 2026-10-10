import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspacesService } from './workspaces.service';

/** Workspaces nested under their org for scoping, flat by id for direct access. */
@Controller()
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('organizations/:orgId/workspaces')
  listByOrg(@CurrentUser() user: RequestUser, @Param('orgId') orgId: string) {
    return this.workspaces.listByOrg(user.id, orgId);
  }

  @Post('organizations/:orgId/workspaces')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: RequestUser,
    @Param('orgId') orgId: string,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspaces.create(user.id, orgId, dto);
  }

  @Get('workspaces/:id')
  getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.workspaces.getById(user.id, id);
  }

  @Patch('workspaces/:id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaces.update(user.id, id, dto);
  }

  @Delete('workspaces/:id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.workspaces.remove(user.id, id);
  }
}
