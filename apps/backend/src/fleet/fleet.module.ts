import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller';
import { FleetObjectAccess } from './fleet-object-access';
import { FleetObjectsModule } from './fleet-objects.module';
import { FleetService } from './fleet.service';
import { HostCommandQueueModule } from './host-command-queue.module';
import { HostsModule } from '../hosts/hosts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StatsModule } from '../stats/stats.module';

/**
 * Fleet control channel for hosts. Hosts connect outbound to this API
 * for onboarding (enroll/register/heartbeat) and for the command channel they
 * long-poll, so no sandbox machine needs a public port.
 */
@Module({
  imports: [HostsModule, HostCommandQueueModule, FleetObjectsModule, StatsModule, NotificationsModule],
  controllers: [FleetController],
  providers: [FleetService, FleetObjectAccess],
  exports: [FleetService],
})
export class FleetModule {}
