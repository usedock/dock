import { Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { ChatgptService } from './chatgpt.service';

/** The caller's own ChatGPT subscription sign-in; never visible to other members. */
@Controller('chatgpt/connection')
export class ChatgptController {
  constructor(private readonly chatgpt: ChatgptService) {}

  @Get()
  get(@CurrentUser() user: RequestUser) {
    return this.chatgpt.get(user.id);
  }

  @Post('device')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() user: RequestUser) {
    return this.chatgpt.start(user.id);
  }

  @Post('device/poll')
  @HttpCode(HttpStatus.OK)
  poll(@CurrentUser() user: RequestUser) {
    return this.chatgpt.poll(user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser) {
    return this.chatgpt.remove(user.id);
  }
}
