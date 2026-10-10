import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

/** Self-service API keys. Raw secrets appear only in the create response. */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(user.id, dto.name, dto.expiresAt ? new Date(dto.expiresAt) : undefined);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  revoke(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.keys.revoke(user.id, id);
  }
}
