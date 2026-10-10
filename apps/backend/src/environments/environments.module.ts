import { Module } from '@nestjs/common';
import { AgentCredentialsModule } from '../agent-credentials/agent-credentials.module';
import { ChatgptModule } from '../chatgpt/chatgpt.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RetentionModule } from '../retention/retention.module';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService } from './environments.service';
import { EnvironmentApplyService } from './environment-apply.service';

/** Versioned environment bundles over org membership; upgrades flow through operations. */
@Module({
  imports: [OrganizationsModule, RetentionModule, AgentCredentialsModule, ChatgptModule],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService, EnvironmentApplyService],
  exports: [EnvironmentsService, EnvironmentApplyService],
})
export class EnvironmentsModule {}
