import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { OperationsService } from './operations.service';
import { RetentionQuery, UpdateRetentionDto } from './dto/retention.dto';
import { RetentionService } from './retention.service';

/** Retention reads/writes and operation polls. Never cached. */
@Controller()
export class RetentionController {
  constructor(
    private readonly retention: RetentionService,
    private readonly ops: OperationsService,
  ) {}

  @Get('account/retention')
  @Header('Cache-Control', 'no-store')
  getPolicy(@CurrentUser() user: RequestUser, @Query() query: RetentionQuery) {
    return this.retention.getPolicy(user.id, query.organizationId);
  }

  @Patch('account/retention')
  @Header('Cache-Control', 'no-store')
  updatePolicy(
    @CurrentUser() user: RequestUser,
    @Query() query: RetentionQuery,
    @Body() dto: UpdateRetentionDto,
  ) {
    if (!query.organizationId) {
      throw new BadRequestException({ code: 'validation_error', message: 'organizationId is required' });
    }
    return this.retention.updatePolicy(user, query.organizationId, dto.enabled, dto.confirmation);
  }

  @Get('operations/:id')
  @Header('Cache-Control', 'no-store')
  getOperation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ops.get(user.id, id);
  }
}
