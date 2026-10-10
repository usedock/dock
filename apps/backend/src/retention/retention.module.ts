import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OperationsService } from './operations.service';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

/** Retention switch plus operation polls; operations shared with dock modules. */
@Module({
  imports: [OrganizationsModule],
  controllers: [RetentionController],
  providers: [RetentionService, OperationsService],
  exports: [RetentionService, OperationsService],
})
export class RetentionModule {}
