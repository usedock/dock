import { Module } from '@nestjs/common';
import { DocksModule } from '../docks/docks.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { ConnectorRunsService } from './connector-runs.service';
import { ConnectorWebhooksController } from './connector-webhooks.controller';
import { ConnectorWebhooksService } from './connector-webhooks.service';
import { ConnectorsModule } from './connectors.module';

/** Inbound events from connected tools and the runs they start; kept apart from ConnectorsModule because DocksModule imports that one. */
@Module({
  imports: [ConnectorsModule, DocksModule, EnvironmentsModule],
  controllers: [ConnectorWebhooksController],
  providers: [ConnectorWebhooksService, ConnectorRunsService],
})
export class ConnectorTriggersModule {}
