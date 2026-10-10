import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountClosureModule } from '../account-closure/account-closure.module';
import { BetterAuthModule } from './better-auth/better-auth.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MeController } from './me.controller';
import { RateLimitService } from './rate-limit.service';

@Module({
  imports: [AccountClosureModule, BetterAuthModule],
  controllers: [MeController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }, RateLimitService],
  // Shared rate limiting for api-keys, webhooks, and github modules.
  exports: [RateLimitService],
})
export class AuthModule {}
