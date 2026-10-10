import { Module } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { ChatgptController } from './chatgpt.controller';
import { ChatgptService } from './chatgpt.service';

@Module({
  controllers: [ChatgptController],
  providers: [ChatgptService, RateLimitService],
  exports: [ChatgptService],
})
export class ChatgptModule {}
