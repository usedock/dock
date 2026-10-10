import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SnapshotQuery } from './dto/snapshot.dto';
import { SnapshotsService } from './snapshots.service';

/** Snapshot reads stream straight from captures; deletes are confirmed operations. */
@Controller()
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Get('snapshots')
  list(@CurrentUser() user: RequestUser, @Query() query: SnapshotQuery) {
    return this.snapshots.listAll(user.id, query.cursor, query.limit);
  }

  @Get('docks/:id/snapshots')
  listByDock(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: SnapshotQuery) {
    return this.snapshots.listByDock(user.id, id, query.cursor, query.limit);
  }

  @Get('docks/:id/snapshots/latest')
  latest(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.snapshots.latest(user.id, id);
  }

  @Get('snapshots/:id/tree')
  tree(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.snapshots.tree(user.id, id);
  }

  @Get('snapshots/:id/files')
  async files(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('path') path: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.snapshots.file(user.id, id, path);
    res.type('application/octet-stream').send(file.content);
  }

  @Get('snapshots/:id/download')
  download(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.snapshots.download(user.id, id);
  }

  @Delete('snapshots/:id')
  @HttpCode(HttpStatus.ACCEPTED)
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Headers('x-confirm-delete') confirm?: string,
  ) {
    return this.snapshots.remove(user.id, id, confirm);
  }
}
