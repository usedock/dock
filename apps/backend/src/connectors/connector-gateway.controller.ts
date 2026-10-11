import { All, Controller, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { pipeline, Readable, Transform } from 'node:stream';
import { Public } from '../common/public.decorator';
import { ConnectorGatewayService } from './connector-gateway.service';

/** Response bytes relayed per call; a runaway upstream is cut off past this. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const RELAYED_HEADERS = ['content-type', 'cache-control', 'mcp-session-id', 'retry-after', 'x-request-id'];

/** Dock-only proxy to tool APIs and MCP servers; auth is the dock-scoped token, so the route is public. */
// Gateway for docks, not a client API: kept out of the public contract and SDKs.
@ApiExcludeController()
@Controller('connectors/gateway')
export class ConnectorGatewayController {
  constructor(private readonly gateway: ConnectorGatewayService) {}

  @All(':kind/*path')
  @Public()
  async proxy(@Param('kind') kind: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const params = req.params as Record<string, string | string[]>;
    const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '');
    const queryAt = req.originalUrl.indexOf('?');
    const { response } = await this.gateway.forward({
      kind,
      path,
      query: queryAt === -1 ? '' : req.originalUrl.slice(queryAt),
      method: req.method,
      headers: req.headers,
      body: Buffer.isBuffer(req.body) ? req.body : undefined,
    });
    res.status(response.status);
    for (const name of RELAYED_HEADERS) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!response.body) {
      res.end();
      return;
    }
    // Event streams must flush per chunk, never buffer whole responses.
    res.flushHeaders();
    let sent = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        sent += chunk.length;
        if (sent > MAX_RESPONSE_BYTES) done(new Error('response too large'));
        else done(null, chunk);
      },
    });
    pipeline(Readable.fromWeb(response.body as never), limit, res, (err) => {
      if (err) res.destroy();
    });
  }
}
