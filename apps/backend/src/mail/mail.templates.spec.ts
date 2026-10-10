import { MailService } from './mail.service';

// Render-only tests: no SMTP, no Nest context; config falls back to defaults.
const defaults = { get: (_key: string, fallback?: unknown) => fallback };
const mail = new MailService(defaults as never);

describe('mail templates', () => {
  it('verify-email and reset-password share the layout header and footer', () => {
    const verify = mail.render('verify-email', {
      subject: 'Verify',
      email: 'you@example.com',
      verifyUrl: 'http://localhost:3000/verify-email?token=abc',
    });
    const reset = mail.render('reset-password', {
      subject: 'Reset',
      email: 'you@example.com',
      resetUrl: 'http://localhost:3000/reset-password?token=abc',
    });
    for (const { html } of [verify, reset]) {
      expect(html).toContain('>dock<');
      expect(html).toContain('A persistent computer for every agent.');
      expect(html).toContain('hello@usedock.io');
    }
  });

  it('names the configured CONTACT_INBOX as the support address', () => {
    const selfHosted = new MailService({
      get: (key: string, fallback?: unknown) => (key === 'CONTACT_INBOX' ? 'ops@example.com' : fallback),
    } as never);
    for (const template of ['verify-email', 'account-closed'] as const) {
      const { html } = selfHosted.render(template, { subject: 'x', email: 'you@example.com' });
      expect(html).toContain('ops@example.com');
      expect(html).not.toContain('usedock.io');
    }
  });

  it('organization-invitation renders the org, role and accept link', () => {
    const { html, text } = mail.render('organization-invitation', {
      subject: 'Invited',
      email: 'bee@example.com',
      orgName: 'Acme',
      role: 'admin',
      inviteUrl: 'https://dash.example.com/invitations/abc',
    });
    expect(html).toContain('Join Acme on Dock');
    expect(html).toContain('https://dash.example.com/invitations/abc');
    expect(text).toContain('Acme');
    expect(text).toContain('https://dash.example.com/invitations/abc');
  });

  it('verify-code renders the OTP and a plain-text fallback', () => {
    const { html, text } = mail.render('verify-code', {
      subject: 'Code',
      email: 'you@example.com',
      code: '123456',
    });
    expect(html).toContain('123456');
    expect(html).toContain('>dock<');
    expect(text).toContain('123456');
  });

  it('no template uses rounded geometry', () => {
    for (const template of ['verify-email', 'reset-password', 'verify-code'] as const) {
      const { html } = mail.render(template, {
        subject: 't',
        email: 'you@example.com',
        verifyUrl: 'http://localhost:3000/x?token=abc',
        resetUrl: 'http://localhost:3000/x?token=abc',
      });
      expect(html.toLowerCase()).not.toContain('border-radius');
    }
  });

  it('every template ships a plain-text alternative with expanded links', () => {
    const { text } = mail.render('verify-email', {
      subject: 'Verify',
      email: 'you@example.com',
      verifyUrl: 'http://localhost:3000/verify-email?token=abc123',
    });
    expect(text).toContain('http://localhost:3000/verify-email?token=abc123');
  });

  it('account-closed carries the purge date in both alternatives', () => {
    const { html, text } = mail.render('account-closed', {
      subject: 'Closed',
      email: 'you@example.com',
      purgeDate: '2026-10-07',
    });
    expect(html).toContain('>dock<');
    expect(html).toContain('2026-10-07');
    expect(text).toContain('2026-10-07');
  });

  it('alert templates share the layout and carry the product theme', () => {
    for (const template of ['stopped_responding', 'stop_refused', 'disk_warning', 'disk_full'] as const) {
      const { html } = mail.render(template, {
        subject: 'Alert',
        linkUrl: 'http://localhost:3000/docks/d1',
        dockName: 'dev',
        detail: 'dev crossed the disk warning line.',
      });
      expect(html).toContain('>dock<');
      expect(html).toContain('A persistent computer for every agent.');
      expect(html).toContain('hello@usedock.io');
      expect(html).toContain('#b7f34a');
      expect(html).toContain('IBM Plex Mono');
      expect(html.toLowerCase()).not.toContain('border-radius');
    }
  });

  it('alert plain-text alternatives carry the expanded deep link', () => {
    const { text } = mail.render('disk_full', {
      subject: 'Full',
      linkUrl: 'http://localhost:3000/docks/d1',
      dockName: 'dev',
      detail: 'dev is out of disk.',
    });
    expect(text).toContain('http://localhost:3000/docks/d1');
    expect(text).toContain('dev');
  });
});
