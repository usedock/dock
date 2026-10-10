import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DockletClient } from '../runtime/docklet.client';
import { RuntimeModule } from '../runtime/runtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MeteringModule } from '../metering/metering.module';
import { HostCommandQueueModule } from '../fleet/host-command-queue.module';
import { HostCommandQueue } from '../fleet/host-command-queue';
import { DOCKLETS, buildDockletFactory } from './docklets.factory';
import { HostsController } from './hosts.controller';
import { HostsService } from './hosts.service';
import { ReconcilerService } from './reconciler.service';

/** Host fleet: placement, reconciler, and an instance-admin read view. */
@Module({
  imports: [RuntimeModule, NotificationsModule, HostCommandQueueModule, MeteringModule],
  controllers: [HostsController],
  providers: [
    HostsService,
    {
      provide: DOCKLETS,
      inject: [HostsService, ConfigService, DockletClient, HostCommandQueue],
      useFactory: buildDockletFactory,
    },
    ReconcilerService,
  ],
  exports: [HostsService, ReconcilerService, DOCKLETS],
})
export class HostsModule {}
