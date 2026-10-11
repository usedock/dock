import { Module } from '@nestjs/common';
import { SentryModule } from '@sentry/nestjs/setup';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/validate-env';
import { AccountClosureModule } from './account-closure/account-closure.module';
import { AgentCredentialsModule } from './agent-credentials/agent-credentials.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { ConnectorTriggersModule } from './connectors/connector-triggers.module';
import { ChatgptModule } from './chatgpt/chatgpt.module';
import { ContactModule } from './contact/contact.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuthModule } from './auth/auth.module';
import { BetterAuthModule } from './auth/better-auth/better-auth.module';
import { DatabaseModule } from './database/database.module';
import { DocksModule } from './docks/docks.module';
import { EnvironmentsModule } from './environments/environments.module';
import { MeteringModule } from './metering/metering.module';
import { SpendGateModule } from './metering/spend-gate.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WebhookDispatchModule } from './webhooks/webhook-dispatch.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { GithubModule } from './github/github.module';
import { ProfilesModule } from './profiles/profiles.module';
import { RetentionModule } from './retention/retention.module';
import { SshKeysModule } from './ssh-keys/ssh-keys.module';
import { SnapshotsModule } from './snapshots/snapshots.module';
import { FleetModule } from './fleet/fleet.module';
import { HostsModule } from './hosts/hosts.module';
import { StatsModule } from './stats/stats.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    // Request isolation for Sentry; reporting stays in HttpExceptionFilter.
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    UsersModule,
    ProfilesModule,
    MailModule,
    NotificationsModule,
    AuthModule,
    BetterAuthModule,
    ApiKeysModule,
    SshKeysModule,
    AgentCredentialsModule,
    ChatgptModule,
    ConnectorsModule,
    ContactModule,
    WorkspacesModule,
    GithubModule,
    SnapshotsModule,
    HostsModule,
    FleetModule,
    StatsModule,
    RetentionModule,
    AccountClosureModule,
    SpendGateModule.forRoot(),
    MeteringModule,
    WebhooksModule,
    WebhookDispatchModule,
    TelemetryModule,
  ],
})
export class AppModule {}
