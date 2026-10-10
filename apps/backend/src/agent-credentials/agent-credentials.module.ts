import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AgentCredentialsController } from './agent-credentials.controller';
import { AgentCredentialsService } from './agent-credentials.service';

/** Org provider keys over org membership; imported by environments for injection. */
@Module({
  imports: [OrganizationsModule],
  controllers: [AgentCredentialsController],
  providers: [AgentCredentialsService],
  exports: [AgentCredentialsService],
})
export class AgentCredentialsModule {}
