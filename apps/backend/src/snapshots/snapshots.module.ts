import { Module } from '@nestjs/common';
import { DocksModule } from '../docks/docks.module';
import { HostsModule } from '../hosts/hosts.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RetentionModule } from '../retention/retention.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/** Snapshot reads/deletes plus template lifecycle over dock membership. */
@Module({
  imports: [OrganizationsModule, RetentionModule, DocksModule, HostsModule, RuntimeModule],
  controllers: [SnapshotsController, TemplatesController],
  providers: [SnapshotsService, TemplatesService],
  exports: [SnapshotsService, TemplatesService],
})
export class SnapshotsModule {}
