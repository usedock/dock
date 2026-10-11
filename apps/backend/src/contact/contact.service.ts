import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { MailService } from '../mail/mail.service';
import { CONTACT_TOPICS, type ContactTopic } from './dto/contact.dto';

/** Three messages per address per hour: room for a real conversation, not for a flood. */
const RATE_LIMIT = 3;
const RATE_WINDOW_SECONDS = 3600;
const CONFIRM_WINDOW_SECONDS = 24 * 3600;
const DEFAULT_INBOX = 'hello@usedock.io';

export interface ContactSubmission {
  name: string;
  email: string;
  company: string;
  topic: ContactTopic;
  message: string;
  /** Client address the rate-limit bucket is keyed on. */
  ip: string;
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger('ContactService');

  constructor(
    private readonly mail: MailService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Throttles per client address, then delivers to the contact inbox with the
   * visitor as reply-to. Delivery is awaited so a 200 means the relay accepted
   * the message: a silent failure would lose the message outright.
   */
  async submit(input: ContactSubmission): Promise<{ sent: true }> {
    const inbox = this.config.get<string>('CONTACT_INBOX', DEFAULT_INBOX);
    const { allowed } = await this.limits.hit(
      `rl:contact:${input.ip}`,
      RATE_LIMIT,
      RATE_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        {
          code: 'rate_limited',
          message: `Too many messages from this address. Try again later, or write to ${inbox}.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const topic = CONTACT_TOPICS[input.topic];
    const subject = `${topic.startsWith('Dock ') ? '' : 'Dock '}${topic} - ${input.name}${input.company ? ` (${input.company})` : ''}`;
    const { messageId } = await this.mail.send({
      to: inbox,
      replyTo: input.email,
      subject,
      template: 'contact-message',
      context: {
        name: input.name,
        email: input.email,
        company: input.company || 'Not provided',
        topic,
        message: input.message,
      },
    });
    if (!messageId) {
      throw new ServiceUnavailableException({
        code: 'mail_unavailable',
        message: `Could not deliver your message. Write to ${inbox} directly.`,
      });
    }
    if (input.topic === 'cloud-waitlist') await this.confirmWaitlist(input.email);
    return { sent: true };
  }

  /** One confirmation per address per 24 h. Never throws; a limiter error means no mail. */
  private async confirmWaitlist(email: string): Promise<void> {
    try {
      const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
      const { allowed } = await this.limits.hit(
        `rl:contact-confirm:${digest}`,
        1,
        CONFIRM_WINDOW_SECONDS,
      );
      if (!allowed) return;
      const inbox = this.config.get<string>('CONTACT_INBOX', DEFAULT_INBOX);
      const { messageId } = await this.mail.send({
        to: email,
        replyTo: inbox,
        subject: 'You are on the Dock Cloud waitlist',
        template: 'waitlist-confirmation',
        context: { email },
      });
      if (!messageId) this.logger.warn('waitlist confirmation not delivered');
    } catch (err) {
      this.logger.warn(`waitlist confirmation skipped: ${(err as Error).message}`);
    }
  }
}
