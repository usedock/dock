import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { MailService, MailTemplate } from './mail.service';

const SAMPLES: Record<MailTemplate, { subject: string; context: Record<string, string> }> = {
  'verify-email': {
    subject: 'Verify your Dock email',
    context: {
      email: 'you@example.com',
      verifyUrl: 'http://localhost:3000/verify-email?token=preview',
    },
  },
  'reset-password': {
    subject: 'Reset your Dock password',
    context: {
      email: 'you@example.com',
      resetUrl: 'http://localhost:3000/reset-password?token=preview',
    },
  },
  'verify-code': {
    subject: 'Your Dock sign-in code',
    context: { email: 'you@example.com', code: '123456' },
  },
  'account-closed': {
    subject: 'Your Dock account is closed',
    context: { email: 'you@example.com', purgeDate: '2026-10-07' },
  },
  stopped_responding: {
    subject: 'Dock stopped responding: dev',
    context: {
      linkUrl: 'http://localhost:3000/docks/preview',
      dockName: 'dev',
      detail: 'dev went silent. The disk is kept 7 days and billing is paused.',
    },
  },
  stop_refused: {
    subject: 'Dock could not be stopped: dev',
    context: {
      linkUrl: 'http://localhost:3000/docks/preview',
      dockName: 'dev',
      detail: 'dev is still running because its snapshot keeps failing. Billing is paused.',
    },
  },
  disk_warning: {
    subject: 'Dock disk almost full: dev',
    context: {
      linkUrl: 'http://localhost:3000/docks/preview',
      dockName: 'dev',
      detail: 'dev crossed the disk warning line at 82% of its default disk.',
    },
  },
  disk_full: {
    subject: 'Dock disk full: dev',
    context: {
      linkUrl: 'http://localhost:3000/docks/preview',
      dockName: 'dev',
      detail: 'dev is out of disk and its snapshots are failing.',
    },
  },
  auto_recovered: {
    subject: 'Dock was auto-recovered: dev',
    context: {
      linkUrl: 'http://localhost:3000/docks/preview',
      dockName: 'dev',
      detail: 'dev was rebuilt from its latest snapshot.',
    },
  },
  held_after_loss: {
    subject: 'Dock is held after machine loss: dev',
    context: {
      linkUrl: 'http://localhost:3000/docks/preview',
      dockName: 'dev',
      detail: 'dev is held 3 days because its snapshot is older than the failure.',
    },
  },
  'organization-invitation': {
    subject: 'You are invited to Acme on Dock',
    context: {
      email: 'you@example.com',
      orgName: 'Acme',
      role: 'member',
      inviteUrl: 'http://localhost:3002/invitations/preview',
    },
  },
  'contact-message': {
    subject: 'Dock Request access - Ada Lovelace (Acme)',
    context: {
      name: 'Ada Lovelace',
      email: 'ada@acme.dev',
      company: 'Acme',
      topic: 'Request access',
      message:
        'We run coding agents over a monorepo with Docker builds.\nThey need checkpoints across runs and preview URLs for QA.',
    },
  },
};

/** Dev-only visual review of every template. Excluded from production builds. */
@Public()
@Controller('dev/mail')
export class MailPreviewController {
  constructor(private readonly mail: MailService) {}

  @Get(':template')
  preview(@Param('template') template: string, @Res() res: Response): void {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException({ code: 'not_found', message: 'Not found' });
    }
    const sample = SAMPLES[template as MailTemplate];
    if (!sample) {
      throw new NotFoundException({ code: 'not_found', message: 'Unknown template' });
    }
    const { html } = this.mail.render(template as MailTemplate, {
      subject: sample.subject,
      ...sample.context,
    });
    res.type('text/html').send(html);
  }
}
