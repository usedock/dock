import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import Handlebars from 'handlebars';
import nodemailer, { Transporter } from 'nodemailer';
import { mailDelivery } from '../config/instance';
import { hashToken, newUuid } from '../crypto/tokens';

export type MailTemplate =
  | 'verify-email'
  | 'verify-code'
  | 'reset-password'
  | 'account-closed'
  | 'stopped_responding'
  | 'stop_refused'
  | 'disk_warning'
  | 'disk_full'
  | 'auto_recovered'
  | 'held_after_loss'
  | 'contact-message'
  | 'waitlist-confirmation'
  | 'organization-invitation';

export interface MailContext {
  subject: string;
  email?: string;
  code?: string;
  verifyUrl?: string;
  resetUrl?: string;
  purgeDate?: string;
  linkUrl?: string;
  dockName?: string;
  detail?: string;
  name?: string;
  company?: string;
  topic?: string;
  message?: string;
  orgName?: string;
  role?: string;
  inviteUrl?: string;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  template: MailTemplate;
  context: Omit<MailContext, 'subject'>;
  /** Sends the reply back to the visitor instead of the relay's own inbox. */
  replyTo?: string;
}

const RETRY_DELAYS_MS = [1000, 5000, 25000];
const DEFAULT_SUPPORT_EMAIL = 'hello@usedock.io';

function templatesDir(): string {
  const fromCompiled = join(__dirname, 'templates');
  if (existsSync(join(fromCompiled, 'layout.hbs'))) return fromCompiled;
  return join(process.cwd(), 'src', 'mail', 'templates');
}

function textFor(template: MailTemplate, context: MailContext): string {
  switch (template) {
    case 'verify-email':
      return `Confirm ${context.email ?? 'this address'} on Dock (link expires in 24 hours): ${context.verifyUrl}`;
    case 'verify-code':
      return `Your Dock sign-in code is ${context.code ?? ''} (expires in 10 minutes).`;
    case 'reset-password':
      return `Someone requested a password reset for ${context.email ?? 'your account'} on Dock (link expires in 1 hour). If that was not you, ignore this message: ${context.resetUrl}`;
    case 'account-closed':
      return `Your Dock account is closed. Your docks are archived and your plan is cancelled. Your data is purged for good on ${context.purgeDate ?? 'the date in your confirmation'}. Reopen before then to bring everything back.`;
    case 'stopped_responding':
      return `${context.dockName ?? 'Your dock'} stopped responding on Dock. ${context.detail ?? ''} Open it: ${context.linkUrl}`;
    case 'stop_refused':
      return `${context.dockName ?? 'Your dock'} could not be stopped on Dock. ${context.detail ?? ''} Open it: ${context.linkUrl}`;
    case 'disk_warning':
      return `${context.dockName ?? 'Your dock'} is almost full on Dock. ${context.detail ?? ''} Open it: ${context.linkUrl}`;
    case 'disk_full':
      return `${context.dockName ?? 'Your dock'} is out of disk on Dock. ${context.detail ?? ''} Open it: ${context.linkUrl}`;
    case 'auto_recovered':
      return `${context.dockName ?? 'Your dock'} was auto-recovered on Dock. ${context.detail ?? ''} Open it: ${context.linkUrl}`;
    case 'held_after_loss':
      return `${context.dockName ?? 'Your dock'} is held after machine loss on Dock. ${context.detail ?? ''} Open it: ${context.linkUrl}`;
    case 'organization-invitation':
      return `You were invited to join ${context.orgName ?? 'an organization'} on Dock as ${context.role ?? 'member'}. Sign in with ${context.email ?? 'your email'} to accept (link expires in 7 days): ${context.inviteUrl}`;
    case 'waitlist-confirmation':
      return [
        'You are on the Dock Cloud waitlist. Dock Cloud is coming soon, and we will write to you at this address when invites open.',
        'Dock is free to self-host today: https://docs.usedock.io/self-hosting',
        '',
        'To be removed from the list, reply to this email.',
      ].join('\n');
    case 'contact-message':
      return [
        `${context.name ?? 'A visitor'} wrote from ${context.email ?? 'an unknown address'}.`,
        `Company: ${context.company ?? 'Not provided'}`,
        `Topic: ${context.topic ?? 'Request access'}`,
        '',
        context.message ?? '',
      ].join('\n');
  }
}

/**
 * Single send entry for every backend module. Renders the shared layout +
 * partials, delivers over SMTP with backoff, and never throws: render and
 * transport failures are logged with a correlation id and the API path
 * stays green.
 */
/** Keeps the first character and the domain, so log-only mode shows which mail went where without the raw address. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address[0]}***${address.slice(at)}`;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');
  private transporter: Transporter | null = null;
  private readonly handlebars = Handlebars.create();
  /** No SMTP_HOST: messages (including links and codes) go to the log so self-hosters can finish auth flows. */
  private readonly logOnly: boolean;

  constructor(private readonly config: ConfigService) {
    this.registerPartials();
    this.logOnly = mailDelivery(config) === 'log';
    if (this.logOnly) {
      this.logger.warn('SMTP_HOST is not set: mail is written to this log instead of being delivered');
    }
  }

  /** Rendered HTML + plain text without sending (preview route, tests). */
  render(template: MailTemplate, context: MailContext): { html: string; text: string } {
    const dir = templatesDir();
    const scope = { ...context, supportEmail: this.config.get<string>('CONTACT_INBOX', DEFAULT_SUPPORT_EMAIL) };
    const body = this.handlebars.compile(readFileSync(join(dir, `${template}.hbs`), 'utf8'))(scope);
    const html = this.handlebars.compile(readFileSync(join(dir, 'layout.hbs'), 'utf8'))({
      ...scope,
      body,
    });
    return { html, text: textFor(template, context) };
  }

  /** Queue for delivery with retry. Never rejects. */
  async send(options: SendMailOptions): Promise<{ messageId: string | null }> {
    const correlationId = newUuid();
    // Correlation without secrets: hash proves linkage, reveals nothing.
    this.logger.log(
      `mail queued template=${options.template} toHash=${hashToken(options.to).slice(0, 12)} cid=${correlationId}`,
    );
    let rendered: { html: string; text: string };
    try {
      rendered = this.render(options.template, { ...options.context, subject: options.subject });
    } catch (err) {
      this.logger.error(
        `mail render failed template=${options.template} cid=${correlationId}: ${(err as Error).message}`,
      );
      return { messageId: null };
    }
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const info = await this.transport().sendMail({
          from: this.config.getOrThrow<string>('SMTP_FROM'),
          to: options.to,
          subject: options.subject,
          html: rendered.html,
          text: rendered.text,
          ...(options.replyTo ? { replyTo: options.replyTo } : {}),
          headers: { 'X-Dock-Template': options.template, 'X-Dock-Cid': correlationId },
        });
        if (this.logOnly) {
          this.logger.warn(`mail not delivered (no SMTP_HOST) template=${options.template} to=${maskAddress(options.to)} cid=${correlationId}\n${rendered.text}`);
        } else {
          this.logger.log(`mail delivered template=${options.template} cid=${correlationId}`);
        }
        return { messageId: info.messageId ?? null };
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.logger.error(
            `mail failed template=${options.template} cid=${correlationId}: ${(err as Error).message}`,
          );
          return { messageId: null };
        }
        this.logger.warn(
          `mail retry template=${options.template} cid=${correlationId} in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return { messageId: null };
  }

  private transport(): Transporter {
    if (!this.transporter) {
      if (this.logOnly) {
        this.transporter = nodemailer.createTransport({ jsonTransport: true });
        return this.transporter;
      }
      const user = this.config.get<string>('SMTP_USER', '');
      this.transporter = nodemailer.createTransport({
        host: this.config.getOrThrow<string>('SMTP_HOST'),
        port: this.config.get<number>('SMTP_PORT', 1025),
        auth: user ? { user, pass: this.config.get<string>('SMTP_PASS', '') } : undefined,
      });
    }
    return this.transporter;
  }

  private registerPartials(): void {
    const partialsDir = join(templatesDir(), 'partials');
    for (const file of readdirSync(partialsDir)) {
      if (!file.endsWith('.hbs')) continue;
      this.handlebars.registerPartial(
        file.slice(0, -'.hbs'.length),
        readFileSync(join(partialsDir, file), 'utf8'),
      );
    }
  }
}
