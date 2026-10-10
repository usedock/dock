import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { PinnedHttpsWebhookTransport, WebhookTransport } from './webhook-transport';
import { WebhooksModule } from './webhooks.module';

/**
 * Signed dispatch loop. Separate module because the per-endpoint rate cap
 * needs AuthModule, which the lean WebhooksModule must never import back.
 */
@Module({
  imports: [WebhooksModule, AuthModule],
  providers: [WebhookDispatchService, { provide: WebhookTransport, useClass: PinnedHttpsWebhookTransport }],
})
export class WebhookDispatchModule {}
