import { AllowDockKey } from '../common/allow-dock-key.decorator';
import { Controller, Get, Param, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { DocksService } from '../docks/docks.service';
import { StatsQuery } from './dto/stats-query.dto';
import { StatsService } from './stats.service';

/** Dock stats read: membership-checked current sample plus optional windowed aggregate. */
@Controller()
export class StatsController {
  constructor(
    private readonly stats: StatsService,
    private readonly docks: DocksService,
  ) {}

  @AllowDockKey()
  @Get('docks/:id/stats')
  async getStats(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: StatsQuery) {
    const { dock } = await this.docks.loadDock(user.id, id);
    const sample = await this.stats.current(dock.id);
    const window =
      query.window === undefined ? undefined : await this.stats.window(dock.id, this.stats.checkedWindow(query.window));
    return {
      dockId: dock.id,
      state: dock.state,
      sample,
      ...(window === undefined ? {} : { window }),
    };
  }
}
