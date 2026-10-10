import { ContactService } from './contact.service';
import { vi, type Mock } from 'vitest';

function makeService(overrides: { allowed?: boolean } = {}) {
  const mail = { send: vi.fn().mockResolvedValue({ messageId: 'm1' }) };
  const limits = {
    hit: vi.fn().mockResolvedValue({ allowed: overrides.allowed ?? true, count: 1 }),
  };
  const config = {
    get: vi.fn((k: string, dflt?: unknown) => (k === 'CONTACT_INBOX' ? 'hello@usedock.io' : dflt)),
  };
  const service = new ContactService(mail as never, limits as never, config as never);
  return { service, mail, limits };
}

const submission = {
  name: 'Ada Lovelace',
  email: 'ada@acme.dev',
  company: 'Acme',
  topic: 'pricing-plans' as const,
  message: 'We need a dock per task with Docker builds and preview URLs.',
  ip: '203.0.113.7',
};

describe('ContactService.submit', () => {
  it('delivers to the inbox with the visitor as reply-to and the topic label in the subject', async () => {
    const { service, mail } = makeService();

    await expect(service.submit(submission)).resolves.toEqual({ sent: true });

    const payload = (mail.send as Mock).mock.calls[0][0];
    expect(payload.to).toBe('hello@usedock.io');
    expect(payload.replyTo).toBe('ada@acme.dev');
    expect(payload.subject).toBe('Dock Pricing and plans - Ada Lovelace (Acme)');
    expect(payload.template).toBe('contact-message');
    expect(payload.context).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@acme.dev',
      company: 'Acme',
      topic: 'Pricing and plans',
    });
  });

  it('does not double the Dock prefix for the waitlist topic', async () => {
    const { service, mail } = makeService();

    await service.submit({ ...submission, topic: 'cloud-waitlist' });

    expect((mail.send as Mock).mock.calls[0][0].subject).toBe(
      'Dock Cloud waitlist - Ada Lovelace (Acme)',
    );
  });

  it('says the company was not provided rather than rendering blank', async () => {
    const { service, mail } = makeService();

    await service.submit({ ...submission, company: '' });

    expect((mail.send as Mock).mock.calls[0][0].context.company).toBe('Not provided');
    expect((mail.send as Mock).mock.calls[0][0].subject).toBe(
      'Dock Pricing and plans - Ada Lovelace',
    );
  });

  it('keys the throttle on the client address, not the message body', async () => {
    const { service, limits } = makeService();

    await service.submit(submission);

    expect((limits.hit as Mock).mock.calls[0]).toEqual(['rl:contact:203.0.113.7', 3, 3600]);
  });

  it('rejects with 429 and never sends once the window is exhausted', async () => {
    const { service, mail } = makeService({ allowed: false });

    await expect(service.submit(submission)).rejects.toMatchObject({
      status: 429,
      response: { code: 'rate_limited' },
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('fails the request when the relay refused the message, so nothing is lost silently', async () => {
    const { service, mail } = makeService();
    (mail.send as Mock).mockResolvedValue({ messageId: null });

    await expect(service.submit(submission)).rejects.toMatchObject({
      status: 503,
      response: { code: 'mail_unavailable' },
    });
  });
});
