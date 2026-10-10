import { Module } from '@nestjs/common';
import { FleetObjectsService, snapshotStoreProvider } from './fleet-objects.service';

/**
 * Central-store access in isolation: generation objects live here, so both the
 * fleet API (host uploads) and the runtime plane (deleting a generation when its
 * snapshot row goes away) can use it without depending on each other. Keeping it
 * separate is what keeps the module graph acyclic.
 */
@Module({
  providers: [FleetObjectsService, snapshotStoreProvider],
  exports: [FleetObjectsService],
})
export class FleetObjectsModule {}
