import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/** Standalone tenancy module; import one-directionally, never from auth. */
@Module({
  imports: [MailModule],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrganizationsService, InvitationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
