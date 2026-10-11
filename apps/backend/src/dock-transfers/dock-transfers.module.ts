import { Module } from '@nestjs/common';
import { DocksModule } from '../docks/docks.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { FleetObjectsModule } from '../fleet/fleet-objects.module';
import { HostsModule } from '../hosts/hosts.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RetentionModule } from '../retention/retention.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DockTransfersController } from './dock-transfers.controller';
import { DockTransfersService } from './dock-transfers.service';

/** Push and pull of a dock's disk: import uploads, exports and their expiry sweep. */
@Module({
  imports: [DocksModule, EnvironmentsModule, FleetObjectsModule, HostsModule, OrganizationsModule, RetentionModule, WorkspacesModule],
  controllers: [DockTransfersController],
  providers: [DockTransfersService],
})
export class DockTransfersModule {}
