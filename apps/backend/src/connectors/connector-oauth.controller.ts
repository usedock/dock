import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { Public } from '../common/public.decorator';
import { ConnectorOauthService } from './connector-oauth.service';
import { ConnectorOauthStartQuery } from './dto/connect-connector.dto';

/** OAuth2 sign-in for connectors; enabled per kind by its client id and secret. */
@Controller('connectors')
export class ConnectorOauthController {
  constructor(private readonly oauth: ConnectorOauthService) {}

  @Get(':kind/oauth/start')
  start(@CurrentUser() user: RequestUser, @Param('kind') kind: string, @Query() query: ConnectorOauthStartQuery) {
    return this.oauth.start(user.id, kind, query.workspaceId);
  }

  /** The vendor redirects the browser here; the signed state carries who started the flow. */
  @Public()
  @Get(':kind/oauth/callback')
  async callback(
    @Param('kind') kind: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.oauth.callback(kind, { code, state, error }));
  }
}
