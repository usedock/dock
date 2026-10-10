import { Module } from '@nestjs/common';
import { DocksModule } from '../docks/docks.module';
import { HostsModule } from '../hosts/hosts.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/** Stats reads authorize like dock item routes; heartbeats ingest host truth. */
@Module({
  imports: [DocksModule, HostsModule],
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}
