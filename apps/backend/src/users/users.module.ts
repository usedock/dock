import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersService } from './users.service';

/** Imports OrganizationsModule for personal-org provisioning inside signup. */
@Module({
  imports: [OrganizationsModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
