import { Module } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { SshKeysController } from './ssh-keys.controller';
import { SshKeysService } from './ssh-keys.service';

/** RateLimitService is provided directly so DocksModule can import this without cycling through AuthModule. */
@Module({
  controllers: [SshKeysController],
  providers: [SshKeysService, RateLimitService],
  exports: [SshKeysService],
})
export class SshKeysModule {}
