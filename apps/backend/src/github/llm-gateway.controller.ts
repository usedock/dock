import { All, Controller, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { LlmGatewayService } from './llm-gateway.service';

/** Streams run LLM calls to the provider; auth is the run token, so the route is public. */
// Runner-only proxy: kept out of the public contract and SDKs.
@ApiExcludeController()
@Controller('llm')
export class LlmGatewayController {
  constructor(private readonly gateway: LlmGatewayService) {}

  @All(':provider/*path')
  @Public()
  async proxy(@Param('provider') provider: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const params = req.params as Record<string, string | string[]>;
    const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '');
    const queryAt = req.originalUrl.indexOf('?');
    const upstream = await this.gateway.forward({
      provider,
      path,
      query: queryAt === -1 ? '' : req.originalUrl.slice(queryAt),
      method: req.method,
      headers: req.headers,
      body: Buffer.isBuffer(req.body) ? req.body : undefined,
    });
    res.status(upstream.status);
    for (const name of ['content-type', 'cache-control', 'request-id', 'x-request-id', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    // Server-sent events must flush per chunk, never buffer whole responses.
    res.flushHeaders();
    Readable.fromWeb(upstream.body as never).pipe(res);
  }
}
