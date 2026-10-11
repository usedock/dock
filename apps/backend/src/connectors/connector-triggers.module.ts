import { Module } from '@nestjs/common';
import { DocksModule } from '../docks/docks.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { GITHUB_API, HttpGithubApi } from '../github/github-api';
import { ConnectorGithub } from './connector-github';
import { ConnectorRepoLinksController } from './connector-repo-links.controller';
import { ConnectorRepoLinksService } from './connector-repo-links.service';
import { ConnectorRepoRunsService } from './connector-repo-runs.service';
import { ConnectorRunsService } from './connector-runs.service';
import { ConnectorWebhooksController } from './connector-webhooks.controller';
import { ConnectorWebhooksService } from './connector-webhooks.service';
import { ConnectorsModule } from './connectors.module';

/** Inbound events from connected tools and the runs they start; kept apart from ConnectorsModule because DocksModule imports that one. */
@Module({
  imports: [ConnectorsModule, DocksModule, EnvironmentsModule],
  controllers: [ConnectorWebhooksController, ConnectorRepoLinksController],
  providers: [ConnectorWebhooksService, ConnectorRunsService, ConnectorRepoLinksService, ConnectorRepoRunsService, ConnectorGithub, { provide: GITHUB_API, useClass: HttpGithubApi }],
})
export class ConnectorTriggersModule {}
