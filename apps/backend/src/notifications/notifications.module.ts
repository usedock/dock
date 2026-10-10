import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** Human notification plane. Import one-directionally; never import dock or billing modules back. */
@Module({
  imports: [OrganizationsModule, MailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
