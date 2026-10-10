import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';

/** Opt-in anonymous usage counts; no controller, nothing is exposed. */
@Module({ providers: [TelemetryService] })
export class TelemetryModule {}
