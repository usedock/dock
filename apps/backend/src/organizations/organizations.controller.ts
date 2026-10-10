import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { AddMemberDto, UpdateMemberRoleDto } from './dto/member.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InvitationsService } from './invitations.service';
import { OrganizationsService } from './organizations.service';

/** Organizations and their membership. Non-members always read 404. */
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly invitations: InvitationsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateOrganizationDto) {
    return this.orgs.create(user.id, dto);
  }

  @Get()
  listMine(@CurrentUser() user: RequestUser) {
    return this.orgs.listMine(user.id);
  }

  @Get(':id')
  getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.getById(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.orgs.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.remove(user.id, id);
  }

  @Get(':id/members')
  listMembers(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.orgs.listMembers(user.id, id);
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.invitations.invite(user.id, id, dto);
  }

  @Patch(':id/members/:userId')
  updateMemberRole(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.orgs.updateMemberRole(user.id, id, targetUserId, dto.role);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.OK)
  removeMember(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.orgs.removeMember(user.id, id, targetUserId);
  }
}
