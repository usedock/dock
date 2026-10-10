import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { Public } from '../common/public.decorator';
import { CompleteInstallationDto, CompleteRunDto, InstallationQuery, RunsQuery, StartInstallationDto, UpdateInstallationDto } from './dto/github.dto';
import { GithubService } from './github.service';

/** GitHub App issue-to-PR runs. Webhook intake is public; everything else authorizes by org. */
@Controller('github')
export class GithubController {
  constructor(private readonly github: GithubService) {}

  @Post('webhooks')
  @Public()
  async webhook(@Req() req: RawBodyRequest<Request>, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const headers = req.headers;
    const first = (value: string | string[] | undefined): string | undefined =>
      Array.isArray(value) ? value[0] : value;
    const out = await this.github.handleWebhookDelivery({
      signature: headers['x-hub-signature-256'],
      deliveryGuid: first(headers['x-github-delivery']),
      hookId: first(headers['x-github-hook-id']),
      event: first(headers['x-github-event']),
      rawBody: req.rawBody ?? Buffer.from(JSON.stringify(body ?? {})),
      body,
    });
    res.status(out.status);
    return out.body;
  }

  @Post('installations/start')
  @HttpCode(HttpStatus.OK)
  startInstallation(@CurrentUser() user: RequestUser, @Body() dto: StartInstallationDto) {
    return this.github.startInstallLink(user, dto.workspaceId, dto.mode);
  }

  @Post('installations/complete')
  @HttpCode(HttpStatus.CREATED)
  completeInstallation(@CurrentUser() user: RequestUser, @Body() dto: CompleteInstallationDto) {
    return this.github.completeInstallLink(user, dto);
  }

  @Patch('installations/:id')
  updateInstallation(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateInstallationDto) {
    return this.github.updateInstallation(user, id, dto);
  }

  @Get('installations')
  listInstallations(@CurrentUser() user: RequestUser, @Query() query: InstallationQuery) {
    return this.github.listInstallations(user.id, query.workspaceId);
  }

  @Delete('installations/:id')
  removeInstallation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.github.removeInstallation(user, id);
  }

  @Get('runs')
  listRuns(@CurrentUser() user: RequestUser, @Query() query: RunsQuery) {
    return this.github.listRuns(user.id, query.workspaceId, query.state);
  }

  @Get('runs/:id')
  getRun(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.github.getRun(user.id, id);
  }
  @Post('runs/:id/promote')
  @HttpCode(HttpStatus.OK)
  promoteRun(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.github.promoteRun(user, id);
  }
  @Post('runs/:id/complete')
  @Public()
  @HttpCode(HttpStatus.OK)
  async completeRun(@Param('id') id: string, @Req() req: Request, @Body() dto: CompleteRunDto) {
    // The guest gets the outcome only, never the run row.
    const run = await this.github.completeRun(id, req.headers.authorization, {
      status: dto.status,
      summary: dto.summary,
      reason: dto.reason,
      testOk: dto.testOk,
      parentSha: dto.parentSha,
      commitMessage: dto.commitMessage,
      changes: dto.changes,
    });
    return { runId: run.id, completionStatus: run.completionStatus };
  }
}
