import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Outbound dock lifecycle webhooks: endpoint management plus the event outbox.
 * Stays free of AuthModule so dock-lifecycle importers never cycle.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
