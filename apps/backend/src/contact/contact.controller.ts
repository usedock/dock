import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/public.decorator';
import { ContactService } from './contact.service';
import { ContactDto } from './dto/contact.dto';

/**
 * Public intake for the marketing contact form: no account, no session.
 * Throttled per client address and delivered to the contact inbox.
 */
@Public()
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  submit(@Body() dto: ContactDto, @Req() req: Request) {
    // Caddy appends the address it saw to any inbound X-Forwarded-For, so the
    // last hop is the one a visitor cannot forge; earlier hops are theirs.
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    const ip = raw?.split(',').pop()?.trim() || req.socket?.remoteAddress || 'unknown';
    return this.contact.submit({ ...dto, company: dto.company ?? '', ip });
  }
}
