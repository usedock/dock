import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { CreateSshKeyDto } from './dto/create-ssh-key.dto';
import { SshKeysService } from './ssh-keys.service';

/** SSH public keys the SSH gateway accepts for the current user. */
@Controller('ssh-keys')
export class SshKeysController {
  constructor(private readonly keys: SshKeysService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSshKeyDto) {
    return this.keys.create(user.id, dto.name, dto.publicKey);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.keys.remove(user.id, id);
  }
}
