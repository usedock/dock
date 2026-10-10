import { Module } from '@nestjs/common';
import { DockletClient } from './docklet.client';
import { FleetObjectsModule } from '../fleet/fleet-objects.module';
import { RestateClient } from './restate.client';

/** Runtime plane clients: Restate ingress plus the docklet host agent. */
@Module({
  imports: [FleetObjectsModule],
  providers: [DockletClient, RestateClient],
  exports: [DockletClient, RestateClient],
})
export class RuntimeModule {}
