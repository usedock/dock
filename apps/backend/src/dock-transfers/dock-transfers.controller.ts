import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Req, Res } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Response } from 'express';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { dockView } from '../docks/dock-view';
import { CompleteImportDto, ImportDockDto } from './dto/dock-transfer.dto';
import { DockTransfersService } from './dock-transfers.service';

/** Moves a dock's disk between control planes: uploads in, downloads out. */
@Controller()
export class DockTransfersController {
  constructor(private readonly transfers: DockTransfersService) {}

  @Post('docks/import')
  @HttpCode(HttpStatus.CREATED)
  startImport(@CurrentUser() user: RequestUser, @Body() dto: ImportDockDto) {
    return this.transfers.startImport(user.id, dto);
  }

  /** Raw part bytes, read straight from the request: no body parser touches them. */
  @Put('docks/import/:importId/parts/:number')
  @HttpCode(HttpStatus.OK)
  async putPart(
    @CurrentUser() user: RequestUser,
    @Param('importId') importId: string,
    @Param('number', ParseIntPipe) number: number,
    @Headers('content-length') length: string | undefined,
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) res: Response,
  ) {
    const declared = length === undefined ? undefined : Number(length);
    const stored = await this.transfers.putPart(user.id, importId, number, request, Number.isFinite(declared) ? declared : undefined);
    // Same etag as the direct upload path, where the client reads S3's ETag header.
    res.setHeader('etag', stored.etag);
    return stored;
  }

  @Post('docks/import/:importId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  complete(@CurrentUser() user: RequestUser, @Param('importId') importId: string, @Body() dto: CompleteImportDto) {
    return this.transfers.completeImport(user.id, importId, dto.parts).then(dockView);
  }

  @Post('docks/:id/export')
  @HttpCode(HttpStatus.ACCEPTED)
  startExport(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.transfers.startExport(user.id, id);
  }

  @Get('docks/exports/:exportId')
  getExport(@CurrentUser() user: RequestUser, @Param('exportId') exportId: string) {
    return this.transfers.getExport(user.id, exportId);
  }

  /** The bytes of a ready export when the store has no address a client can reach; supports `Range` to resume. */
  @Get('docks/exports/:exportId/download')
  async download(
    @CurrentUser() user: RequestUser,
    @Param('exportId') exportId: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.transfers.openDownload(user.id, exportId, range);
    res.status(file.partial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(file.end - file.start + 1));
    if (file.partial) res.setHeader('content-range', `bytes ${file.start}-${file.end}/${file.size}`);
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }
}
