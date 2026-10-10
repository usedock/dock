import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { WebhooksService } from './webhooks.service';
import { CreateEndpointDto, EndpointQuery } from './dto/create-endpoint.dto';

/** Outbound dock lifecycle webhooks. Writes need a browser session, never a service key. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('endpoints')
  @HttpCode(HttpStatus.CREATED)
  createEndpoint(@CurrentUser() user: RequestUser, @Body() dto: CreateEndpointDto) {
    return this.webhooks.create(user, dto.organizationId, dto.name, dto.url, dto.events);
  }

  @Get('endpoints')
  listEndpoints(@CurrentUser() user: RequestUser, @Query() query: EndpointQuery) {
    return this.webhooks.list(user.id, query.organizationId);
  }

  @Get('endpoints/:id')
  getEndpoint(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: EndpointQuery) {
    return this.webhooks.get(user.id, query.organizationId, id);
  }

  @Delete('endpoints/:id')
  removeEndpoint(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: EndpointQuery) {
    return this.webhooks.remove(user, query.organizationId, id);
  }

  @Get('endpoints/:id/deliveries')
  listDeliveries(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: EndpointQuery) {
    return this.webhooks.deliveries(user.id, query.organizationId, id);
  }
}
