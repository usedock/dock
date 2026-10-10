import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { EnvironmentsService } from './environments.service';
import { EnvironmentApplyService } from './environment-apply.service';
import { CreateEnvironmentDto, EnvironmentRefQuery, ListEnvironmentsQuery, UpdateEnvironmentDto, UpgradeEnvironmentDto } from './dto/environment.dto';
import { AddRepoDto } from './dto/repo.dto';
import { BulkSecretsDto, SecretFileDto, SetVarDto } from './dto/secrets.dto';

/** Versioned environment bundles: thin validation-to-service routes. */
@Controller()
export class EnvironmentsController {
  constructor(
    private readonly envs: EnvironmentsService,
    private readonly applier: EnvironmentApplyService,
  ) {}

  @Get('environments')
  list(@CurrentUser() user: RequestUser, @Query() query: ListEnvironmentsQuery) {
    return this.envs.listByOrg(user.id, query.organizationId);
  }

  @Post('environments')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateEnvironmentDto) {
    return this.envs.create(user.id, dto.organizationId, dto.name, dto.secretsAccess);
  }

  @Get('environments/:ref')
  getByRef(@CurrentUser() user: RequestUser, @Param('ref') ref: string, @Query() query: EnvironmentRefQuery) {
    return this.envs.getByRef(user.id, ref, query.organizationId);
  }

  @Patch('environments/:ref')
  update(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Query() query: EnvironmentRefQuery,
    @Body() dto: UpdateEnvironmentDto,
  ) {
    return this.envs.update(user.id, ref, query.organizationId, dto);
  }

  @Delete('environments/:ref')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('ref') ref: string, @Query() query: EnvironmentRefQuery) {
    return this.envs.remove(user.id, ref, query.organizationId);
  }

  @Get('environments/:ref/versions')
  listVersions(@CurrentUser() user: RequestUser, @Param('ref') ref: string, @Query() query: EnvironmentRefQuery) {
    return this.envs.listVersions(user.id, ref, query.organizationId);
  }

  @Post('environments/:ref/upgrade')
  @HttpCode(HttpStatus.ACCEPTED)
  upgrade(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Query() query: EnvironmentRefQuery,
    @Body() dto: UpgradeEnvironmentDto,
  ) {
    return this.applier.upgrade(user.id, ref, query.organizationId, dto.dockIds);
  }

  @Get('environments/:ref/repos')
  listRepos(@CurrentUser() user: RequestUser, @Param('ref') ref: string, @Query() query: EnvironmentRefQuery) {
    return this.envs.listRepos(user.id, ref, query.organizationId);
  }

  @Post('environments/:ref/repos')
  @HttpCode(HttpStatus.CREATED)
  addRepo(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Query() query: EnvironmentRefQuery,
    @Body() dto: AddRepoDto,
  ) {
    return this.envs.addRepo(user.id, ref, query.organizationId, dto);
  }

  @Delete('environments/:ref/repos/:repoId')
  @HttpCode(HttpStatus.OK)
  removeRepo(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Param('repoId') repoId: string,
    @Query() query: EnvironmentRefQuery,
  ) {
    return this.envs.removeRepo(user.id, ref, query.organizationId, repoId);
  }

  @Put('environments/:ref/secrets')
  replaceSecrets(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Query() query: EnvironmentRefQuery,
    @Body() dto: BulkSecretsDto,
  ) {
    return this.envs.replaceSecrets(user.id, ref, query.organizationId, dto);
  }

  @Post('environments/:ref/vars')
  @HttpCode(HttpStatus.OK)
  setVar(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Query() query: EnvironmentRefQuery,
    @Body() dto: SetVarDto,
  ) {
    return this.envs.setVar(user.id, ref, query.organizationId, dto.key, dto.value);
  }

  @Delete('environments/:ref/vars/:key')
  @HttpCode(HttpStatus.OK)
  removeVar(@CurrentUser() user: RequestUser, @Param('ref') ref: string, @Param('key') key: string, @Query() query: EnvironmentRefQuery) {
    return this.envs.removeVar(user.id, ref, query.organizationId, key);
  }

  @Post('environments/:ref/files')
  @HttpCode(HttpStatus.OK)
  setFile(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Query() query: EnvironmentRefQuery,
    @Body() dto: SecretFileDto,
  ) {
    return this.envs.setFile(user.id, ref, query.organizationId, dto.path, dto.contents);
  }

  @Delete('environments/:ref/files/:path')
  @HttpCode(HttpStatus.OK)
  removeFile(
    @CurrentUser() user: RequestUser,
    @Param('ref') ref: string,
    @Param('path') path: string,
    @Query() query: EnvironmentRefQuery,
  ) {
    return this.envs.removeFile(user.id, ref, query.organizationId, path);
  }

  @Post('environments/:ref/secrets:reveal')
  @HttpCode(HttpStatus.OK)
  reveal(@CurrentUser() user: RequestUser, @Param('ref') ref: string, @Query() query: EnvironmentRefQuery) {
    return this.envs.revealSecrets(user.id, ref, query.organizationId);
  }
}
