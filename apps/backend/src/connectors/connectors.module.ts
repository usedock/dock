import { Module } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ConnectorGatewayController } from './connector-gateway.controller';
import { ConnectorGatewayService } from './connector-gateway.service';
import { ConnectorOauthController } from './connector-oauth.controller';
import { ConnectorOauthService } from './connector-oauth.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

/** Workspace tool connections (Figma, Linear, Slack, Sentry) and the dock gateway in front of them. */
@Module({
  imports: [OrganizationsModule, WorkspacesModule],
  controllers: [ConnectorsController, ConnectorOauthController, ConnectorGatewayController],
  providers: [ConnectorsService, ConnectorOauthService, ConnectorGatewayService, RateLimitService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
