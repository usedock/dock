import { Module } from '@nestjs/common';
import { MailPreviewController } from './mail-preview.controller';
import { MailService } from './mail.service';

@Module({
  controllers:
    process.env.NODE_ENV === 'production' ? [] : [MailPreviewController],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
