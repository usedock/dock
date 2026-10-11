import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountClosureModule } from '../account-closure/account-closure.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { FleetObjectsModule } from '../fleet/fleet-objects.module';
import { FleetObjectsService } from '../fleet/fleet-objects.service';
import { DOCKLETS, type DockletFactory } from '../hosts/docklets.factory';
import { RestateComputeProvider } from '../runtime/runtime.provider';
import { HostsModule } from '../hosts/hosts.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { MeteringModule } from '../metering/metering.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RetentionModule } from '../retention/retention.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { COMPUTE_PROVIDER, FakeComputeProvider } from './compute.provider';
import { DocksController } from './docks.controller';
import { DocksService } from './docks.service';
import { DockExecService } from './dock-exec.service';
import { DockTerminalService } from './dock-terminal.service';
import { DockSshGatewayService } from './dock-ssh-gateway.service';
import { DockTunnelService } from './dock-tunnel.service';
import { DockPortsService } from './dock-ports.service';
import { DockPortAccessService } from './dock-port-access.service';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { SshKeysModule } from '../ssh-keys/ssh-keys.module';
import { HostCommandQueueModule } from '../fleet/host-command-queue.module';
import { RateLimitService } from '../auth/rate-limit.service';

/** Dock routes authorize through org membership; deletes flow through operations. */
@Module({
  imports: [BetterAuthModule, OrganizationsModule, WorkspacesModule, ConnectorsModule, RetentionModule, EnvironmentsModule, MeteringModule, WebhooksModule, NotificationsModule, RuntimeModule, HostsModule, FleetObjectsModule, HostCommandQueueModule, SshKeysModule, forwardRef(() => AccountClosureModule)],
  controllers: [DocksController],
  providers: [
    DocksService,
    DockExecService,
    DockTerminalService,
    DockSshGatewayService,
    DockTunnelService,
    DockPortsService,
    DockPortAccessService,
    // Provided directly: importing AuthModule would cycle through AccountClosureModule.
    RateLimitService,
    {
      provide: COMPUTE_PROVIDER,
      inject: [ConfigService, DOCKLETS, FleetObjectsService],
      useFactory: (config: ConfigService, docklets: DockletFactory, objects: FleetObjectsService) =>
        config.get<string>('RUNTIME_DRIVER') === 'restate'
          ? new RestateComputeProvider(docklets, objects)
          : new FakeComputeProvider(),
    },
  ],
  exports: [DocksService, DockTerminalService, COMPUTE_PROVIDER],
})
export class DocksModule {}
