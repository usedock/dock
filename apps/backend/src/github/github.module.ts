import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MeteringModule } from '../metering/metering.module';
import { ChatgptModule } from '../chatgpt/chatgpt.module';
import { DocksModule } from '../docks/docks.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { HostsModule } from '../hosts/hosts.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DOCKLETS, type DockletFactory } from '../hosts/docklets.factory';
import { DockletFastRunProvider, FAST_RUN_PROVIDER } from '../runtime/fast-run.provider';
import { GITHUB_API, HttpGithubApi } from './github-api';
import { GithubAppSetupController } from './github-app-setup.controller';
import { GithubAppSetupService } from './github-app-setup.service';
import { GithubController } from './github.controller';
import { LlmGatewayController } from './llm-gateway.controller';
import { LlmGatewayService } from './llm-gateway.service';
import { GithubService } from './github.service';
import { RunArtifactsService } from './run-artifacts.service';

/**
 * GitHub App issue-to-PR runs. Imports DocksModule for provision/stop and
 * AuthModule for the shared rate limiter; dock lifecycle stays untouched.
 */
@Module({
  imports: [OrganizationsModule, DocksModule, AuthModule, EnvironmentsModule, MeteringModule, HostsModule, ChatgptModule],
  controllers: [GithubController, GithubAppSetupController, LlmGatewayController],
  providers: [
    GithubService,
    GithubAppSetupService,
    RunArtifactsService,
    LlmGatewayService,
    { provide: GITHUB_API, useClass: HttpGithubApi },
    {
      provide: FAST_RUN_PROVIDER,
      inject: [DOCKLETS],
      useFactory: (docklets: DockletFactory) => new DockletFastRunProvider(docklets),
    },
  ],
  exports: [GithubService],
})
export class GithubModule {}
