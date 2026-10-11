import { MailService } from './mail.service';
import { Logger } from '@nestjs/common';
import { vi } from 'vitest';

function makeService() {
  const config = {
    getOrThrow: vi.fn((k: string) => (k === 'SMTP_FROM' ? 'from@x.io' : `v-${k}`)),
    get: vi.fn((_k: string, dflt?: unknown) => dflt),
  };
  const svc = new MailService(config as never);
  const sendMail = vi.fn();
  (svc as any).transporter = { sendMail };
  return { svc, config, sendMail };
}

function silence(svc: any) {
  vi.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
  vi.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
}

describe('MailService without SMTP_HOST', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns at startup and writes the rendered text, link included, to the log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = new MailService({ get: (_k: string, d?: unknown) => d, getOrThrow: () => 'Dock <dock@localhost>' } as never);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SMTP_HOST is not set'));
    const result = await svc.send({
      to: 'a@x.io',
      subject: 'Reset',
      template: 'reset-password',
      context: { email: 'a@x.io', resetUrl: 'http://dock.local/reset?token=t1' },
    });
    expect(result.messageId).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('http://dock.local/reset?token=t1'));
  });

  it('masks the recipient in the log-only line', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = new MailService({ get: (_k: string, d?: unknown) => d, getOrThrow: () => 'Dock <dock@localhost>' } as never);
    await svc.send({ to: 'jane@example.com', subject: 'Hi', template: 'reset-password', context: { email: 'x@y.io', resetUrl: 'http://dock.local/r' } });
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('no SMTP_HOST'))!;
    expect(line).toContain('to=j***@example.com');
    expect(line).not.toContain('jane@example.com');
  });

  it.each([
    ['verify-email', { email: 'jane@example.com', verifyUrl: 'http://dock.local/v?t=1' }, 'http://dock.local/v?t=1'],
    ['reset-password', { email: 'jane@example.com', resetUrl: 'http://dock.local/r?t=1' }, 'http://dock.local/r?t=1'],
    ['organization-invitation', { email: 'jane@example.com', orgName: 'Acme', inviteUrl: 'http://dock.local/i?t=1' }, 'http://dock.local/i?t=1'],
    ['contact-message', { email: 'jane@example.com', name: 'Jane', message: 'hi' }, 'Jane wrote from j***@example.com'],
  ] as const)('masks the address in the logged %s body and keeps the rest', async (template, context, kept) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = new MailService({ get: (_k: string, d?: unknown) => d, getOrThrow: () => 'Dock <dock@localhost>' } as never);
    await svc.send({ to: 'jane@example.com', subject: 'Hi', template, context });
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('no SMTP_HOST'))!;
    expect(line).not.toContain('jane@example.com');
    expect(line).toContain('j***@example.com');
    expect(line).toContain(kept);
  });

  it('delivers over SMTP silently when SMTP_HOST is set', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new MailService({ get: (k: string, d?: unknown) => (k === 'SMTP_HOST' ? 'smtp.example.com' : d) } as never);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('MailService.send', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers on success with to/subject/X-Dock-Template', async () => {
    const { svc, sendMail } = makeService();
    silence(svc);
    sendMail.mockResolvedValue({ messageId: 'm1' });
    vi.spyOn(svc, 'render').mockReturnValue({ html: '<p>hi</p>', text: 'hi' });

    const result = await svc.send({
      to: 'a@x.io',
      subject: 'Hello',
      template: 'verify-email',
      context: {},
    });

    expect(result).toEqual({ messageId: 'm1' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const payload = sendMail.mock.calls[0][0];
    expect(payload.to).toBe('a@x.io');
    expect(payload.subject).toBe('Hello');
    expect(payload.headers['X-Dock-Template']).toBe('verify-email');
  });

  it('carries replyTo only when the caller sets one', async () => {
    const { svc, sendMail } = makeService();
    silence(svc);
    sendMail.mockResolvedValue({ messageId: 'm1' });
    vi.spyOn(svc, 'render').mockReturnValue({ html: '<p>hi</p>', text: 'hi' });

    await svc.send({
      to: 'inbox@x.io',
      subject: 'Hello',
      template: 'contact-message',
      context: {},
    });
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('replyTo');

    await svc.send({
      to: 'inbox@x.io',
      subject: 'Hello',
      template: 'contact-message',
      context: {},
      replyTo: 'visitor@x.io',
    });
    expect(sendMail.mock.calls[1][0].replyTo).toBe('visitor@x.io');
  });

  it('returns null without sending when render fails', async () => {
    const { svc, sendMail } = makeService();
    silence(svc);
    vi.spyOn(svc, 'render').mockImplementation(() => {
      throw new Error('bad');
    });

    const result = await svc.send({
      to: 'a@x.io',
      subject: 'Hello',
      template: 'verify-email',
      context: {},
    });

    expect(result).toEqual({ messageId: null });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('retries 3 times then returns null without rejecting', async () => {
    const { svc, sendMail } = makeService();
    silence(svc);
    vi.spyOn(svc, 'render').mockReturnValue({ html: '<p>hi</p>', text: 'hi' });
    sendMail.mockRejectedValue(new Error('smtp down'));
    const timeoutSpy = vi
      .spyOn(global, 'setTimeout')
      .mockImplementation((fn: any) => {
        (fn as any)();
        return 0 as any;
      });

    let result: unknown;
    await expect(
      (async () => {
        result = await svc.send({
          to: 'a@x.io',
          subject: 'Hello',
          template: 'verify-email',
          context: {},
        });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toEqual({ messageId: null });
    expect(sendMail).toHaveBeenCalledTimes(4);
    timeoutSpy.mockRestore();
  });

  it('logs queued cid without throwing', async () => {
    const { svc, sendMail } = makeService();
    silence(svc);
    const logSpy = vi.spyOn((svc as any).logger, 'log');
    vi.spyOn(svc, 'render').mockReturnValue({ html: '<p>hi</p>', text: 'hi' });
    sendMail.mockResolvedValue({ messageId: 'm1' });

    const result = await svc.send({
      to: 'a@x.io',
      subject: 'Hello',
      template: 'verify-email',
      context: {},
    });

    expect(result).toEqual({ messageId: 'm1' });
    expect(logSpy).toHaveBeenCalled();
  });
});
