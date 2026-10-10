import { Module } from '@nestjs/common';
import { HostCommandQueue } from './host-command-queue';

/**
 * The outbound command channel in isolation: it owns delivery only, so the host
 * registry can depend on it without depending on the fleet API that onboards
 * hosts. Keeping this split keeps the module graph acyclic.
 */
@Module({
  providers: [HostCommandQueue],
  exports: [HostCommandQueue],
})
export class HostCommandQueueModule {}
