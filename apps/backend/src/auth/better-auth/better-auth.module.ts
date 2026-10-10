import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { UsersModule } from '../../users/users.module';
import { BetterAuthService } from './better-auth.service';

@Module({
  imports: [UsersModule, MailModule],
  providers: [BetterAuthService],
  exports: [BetterAuthService],
})
export class BetterAuthModule {}
