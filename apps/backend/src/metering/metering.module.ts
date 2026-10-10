import { Module } from '@nestjs/common';
import { MeteringService } from './metering.service';

/** Activity-window metering; records regardless of billing. */
@Module({
  providers: [MeteringService],
  exports: [MeteringService],
})
export class MeteringModule {}
