import type { Request } from 'express';
import { ContactController } from './contact.controller';
import { vi, type Mock } from 'vitest';

function makeController() {
  const service = { submit: vi.fn().mockResolvedValue({ sent: true }) };
  return { controller: new ContactController(service as never), service };
}

const dto = {
  name: 'Ada Lovelace',
  email: 'ada@acme.dev',
  company: 'Acme',
  topic: 'request-access' as const,
  message: 'We need a dock per task.',
};

function request(headers: Record<string, string>, remoteAddress?: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

describe('ContactController.submit', () => {
  it('keys the throttle on the last forwarded hop, which a caller cannot forge', async () => {
    const { controller, service } = makeController();

    await controller.submit(dto, request({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }));

    expect((service.submit as Mock).mock.calls[0][0]).toMatchObject({
      ...dto,
      ip: '203.0.113.7',
    });
  });

  it('falls back to the socket address when no proxy header is present', async () => {
    const { controller, service } = makeController();

    await controller.submit(dto, request({}, '198.51.100.9'));

    expect((service.submit as Mock).mock.calls[0][0].ip).toBe('198.51.100.9');
  });

  it('normalises an absent company to an empty string', async () => {
    const { controller, service } = makeController();

    await controller.submit(
      { ...dto, company: undefined },
      request({ 'x-forwarded-for': '203.0.113.7' }),
    );

    expect((service.submit as Mock).mock.calls[0][0].company).toBe('');
  });
});
