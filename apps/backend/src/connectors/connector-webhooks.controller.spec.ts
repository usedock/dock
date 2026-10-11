import { vi } from 'vitest';
import { ConnectorWebhooksController } from './connector-webhooks.controller';

function res() {
  const r: any = { status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return r;
}

describe('ConnectorWebhooksController', () => {
  const webhooks = { handle: vi.fn() };
  const runs = { complete: vi.fn() };
  const ctrl = new ConnectorWebhooksController(webhooks as never, runs as never);

  it('hands each vendor route its kind, headers and the raw body', async () => {
    webhooks.handle.mockResolvedValue({ status: 200, body: { received: true } });
    const raw = Buffer.from('{"a":1}');
    const out = res();
    await ctrl.linear({ headers: { 'linear-signature': 'x' }, rawBody: raw } as never, out);
    await ctrl.slack({ headers: {}, rawBody: raw } as never, res());
    await ctrl.sentry({ headers: {}, rawBody: raw } as never, res());
    await ctrl.figma({ headers: {}, rawBody: raw } as never, res());
    expect(webhooks.handle.mock.calls.map((c) => c[0])).toEqual(['linear', 'slack', 'sentry', 'figma']);
    expect(webhooks.handle.mock.calls[0][1]).toEqual({ headers: { 'linear-signature': 'x' }, rawBody: raw });
    expect(out.json).toHaveBeenCalledWith({ received: true });
  });

  it('answers Slack url_verification with the bare challenge, not the API envelope', async () => {
    webhooks.handle.mockResolvedValue({ status: 200, body: 'abc123' });
    const out = res();
    await ctrl.slack({ headers: {}, rawBody: Buffer.from('{}') } as never, out);
    expect(out.type).toHaveBeenCalledWith('text/plain');
    expect(out.send).toHaveBeenCalledWith('abc123');
    expect(out.json).not.toHaveBeenCalled();
  });

  it('passes the completion bearer header to the run service', async () => {
    runs.complete.mockResolvedValue({ runId: 'r1', state: 'succeeded' });
    await ctrl.completeRun('r1', { headers: { authorization: 'Bearer t' } } as never, { status: 'done', summary: 's' });
    expect(runs.complete).toHaveBeenCalledWith('r1', 'Bearer t', { status: 'done', summary: 's' });
  });
});
