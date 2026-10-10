import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { AgentCredentialsService } from './agent-credentials.service';
import { ProviderKeysQuery, SetProviderKeyDto } from './dto/provider-key.dto';

/** Org provider keys: values appear only in set responses, never in reads. */
@Controller('agent-credentials')
export class AgentCredentialsController {
  constructor(private readonly creds: AgentCredentialsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: ProviderKeysQuery) {
    return this.creds.list(user.id, query.organizationId);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  set(@CurrentUser() user: RequestUser, @Body() dto: SetProviderKeyDto) {
    return this.creds.set(user.id, dto.organizationId, dto.provider, dto.key);
  }

  @Get(':provider/reveal')
  reveal(@CurrentUser() user: RequestUser, @Param('provider') provider: string, @Query() query: ProviderKeysQuery) {
    return this.creds.reveal(user.id, query.organizationId, provider);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: RequestUser, @Param('provider') provider: string, @Query() query: ProviderKeysQuery) {
    return this.creds.remove(user.id, query.organizationId, provider);
  }
}
