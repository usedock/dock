import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

/** Public contact intake. Imports AuthModule one-directionally for RateLimitService. */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
