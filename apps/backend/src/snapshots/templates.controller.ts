import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SaveTemplateDto, TemplateOrgQuery } from './dto/snapshot.dto';
import { TemplatesService } from './templates.service';

/** Frozen named states: save, deploy by name, release by name. */
@Controller()
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Post('templates')
  @HttpCode(HttpStatus.ACCEPTED)
  save(@CurrentUser() user: RequestUser, @Body() dto: SaveTemplateDto) {
    return this.templates.save(user.id, dto.dockId, dto.name);
  }

  @Get('templates')
  list(@CurrentUser() user: RequestUser) {
    return this.templates.list(user.id);
  }

  @Get('templates/:name')
  get(@CurrentUser() user: RequestUser, @Param('name') name: string, @Query() query: TemplateOrgQuery) {
    return this.templates.get(user.id, query.organizationId, name);
  }

  @Delete('templates/:name')
  remove(@CurrentUser() user: RequestUser, @Param('name') name: string, @Query() query: TemplateOrgQuery) {
    return this.templates.remove(user.id, query.organizationId, name);
  }
}
