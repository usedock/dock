import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { ConnectorRunsService } from './connector-runs.service';
import { ConnectorWebhooksService } from './connector-webhooks.service';
import type { ConnectorKind } from './connector-kinds';
import { CompleteConnectorRunChangesDto } from './dto/connect-connector.dto';

// Vendor-to-control-plane callbacks, not a client API: kept out of the public contract and SDKs.
@ApiExcludeController()
@Controller('connectors')
export class ConnectorWebhooksController {
  constructor(
    private readonly webhooks: ConnectorWebhooksService,
    private readonly runs: ConnectorRunsService,
  ) {}

  @Post('linear/webhooks')
  @Public()
  @HttpCode(HttpStatus.OK)
  linear(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.deliver('linear', req, res);
  }

  @Post('slack/events')
  @Public()
  @HttpCode(HttpStatus.OK)
  slack(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.deliver('slack', req, res);
  }

  @Post('sentry/webhooks')
  @Public()
  @HttpCode(HttpStatus.OK)
  sentry(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.deliver('sentry', req, res);
  }

  @Post('figma/webhooks')
  @Public()
  @HttpCode(HttpStatus.OK)
  figma(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    return this.deliver('figma', req, res);
  }

  /** Completion callback from the run's dock, authorized by the run's own token. */
  @Post('runs/:id/complete')
  @Public()
  @HttpCode(HttpStatus.OK)
  completeRun(@Param('id') id: string, @Req() req: Request, @Body() dto: CompleteConnectorRunChangesDto) {
    return this.runs.complete(id, req.headers.authorization, dto);
  }

  // Raw response: Slack's URL check wants the bare challenge, not the API envelope.
  private async deliver(kind: ConnectorKind, req: RawBodyRequest<Request>, res: Response): Promise<void> {
    const out = await this.webhooks.handle(kind, { headers: req.headers, rawBody: req.rawBody ?? Buffer.alloc(0) });
    res.status(out.status);
    if (typeof out.body === 'string') res.type('text/plain').send(out.body);
    else res.json(out.body);
  }
}
