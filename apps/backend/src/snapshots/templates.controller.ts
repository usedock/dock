import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SaveTemplateDto, TemplateOrgQuery } from './dto/snapshot.dto';
import { templateView } from './template-view';
import { TemplatesService } from './templates.service';

/** Frozen named states: save, deploy by name, release by name. */
@Controller()
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Post('templates')
  @HttpCode(HttpStatus.ACCEPTED)
  async save(@CurrentUser() user: RequestUser, @Body() dto: SaveTemplateDto) {
    return templateView(await this.templates.save(user.id, dto.dockId, dto.name));
  }

  @Get('templates')
  async list(@CurrentUser() user: RequestUser) {
    return (await this.templates.list(user.id)).map(templateView);
  }

  @Get('templates/:name')
  async get(@CurrentUser() user: RequestUser, @Param('name') name: string, @Query() query: TemplateOrgQuery) {
    return templateView(await this.templates.get(user.id, query.organizationId, name));
  }

  @Delete('templates/:name')
  remove(@CurrentUser() user: RequestUser, @Param('name') name: string, @Query() query: TemplateOrgQuery) {
    return this.templates.remove(user.id, query.organizationId, name);
  }
}
