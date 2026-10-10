import { sealValue, openValue } from '../environments/secrets';
import { WebhookDispatchService, backoffDelayMs, classifyDelivery, eventPayload } from './webhook-dispatch.service';
import { verifyWebhook } from './webhook-signing';
import { WEBHOOK_SIGNATURE_HEADER } from './webhook-dispatch.service';
import { vi, type Mock } from 'vitest';

const KEY = Buffer.from('b'.repeat(64), 'hex');
const SECRET = 'whsec_dispatch_secret';
const orgId = '11111111-1111-4111-8111-111111111111';

const sealed = sealValue(KEY, SECRET);
const endpointRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ep-1',
  organizationId: orgId,
  name: 'Production automation',
  url: 'https://example.com/hooks/dock',
  events: ['dock.ready'],
  secret: sealed,
  secretPrefix: SECRET.slice(0, 8),
  disabled: false,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});
const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  type: 'dock.ready',
  dockId: 'd-1',
  organizationId: orgId,
  workspaceId: 'w-1',
  state: 'ready',
  occurredAt: new Date('2026-09-02T00:00:00Z'),
  createdAt: new Date('2026-09-02T00:00:00Z'),
  ...overrides,
});
const deliveryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'dlv-1',
  eventId: 'evt-1',
  endpointId: 'ep-1',
  status: 'pending',
  attempts: 0,
  nextAttemptAt: new Date('2026-09-02T00:00:01Z'),
  updatedAt: new Date('2026-09-02T00:00:01Z'),
  ...overrides,
});

describe('WebhookDispatchService', () => {
  let db: { select: Mock; insert: Mock; update: Mock };
  let webhooks: { openSecret: Mock; disableEndpoint: Mock; assertDeliverableUrl: Mock };
  let transport: { post: Mock };
  let limits: { hit: Mock };
  let inserted: unknown[];
  let updated: unknown[];
  let service: WebhookDispatchService;

  const selectDue = (rows: unknown[]) => {
    db.select.mockReturnValueOnce({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }),
    });
  };
  const selectOne = (rows: unknown[]) => {
    db.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });
  };

  beforeEach(() => {
    inserted = [];
    updated = [];
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
    db.insert.mockImplementation(() => ({
      values: (values: unknown) => {
        inserted.push(values);
        return Promise.resolve([]);
      },
    }));
    db.update.mockImplementation(() => ({
      set: (values: unknown) => {
        updated.push(values);
        return { where: () => Promise.resolve([]) };
      },
    }));
    webhooks = {
      openSecret: vi.fn().mockImplementation((sealedValue: never) => openValue(KEY, sealedValue)),
      disableEndpoint: vi.fn(),
      assertDeliverableUrl: vi.fn().mockResolvedValue(undefined),
    };
    transport = { post: vi.fn() };
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    const config = { get: vi.fn().mockReturnValue('15000') };
    service = new WebhookDispatchService(db as never, webhooks as never, transport as never, limits as never, config as never);
  });

  it('classifies attempt outcomes', () => {
    expect(classifyDelivery(200)).toBe('sent');
    expect(classifyDelivery(201)).toBe('sent');
    expect(classifyDelivery(null)).toBe('retry');
    expect(classifyDelivery(429)).toBe('retry');
    expect(classifyDelivery(503)).toBe('retry');
    expect(classifyDelivery(410)).toBe('disabled');
    expect(classifyDelivery(400)).toBe('gave_up');
    expect(classifyDelivery(404)).toBe('gave_up');
  });

  it('backs off with a ceiling', () => {
    expect(backoffDelayMs(1)).toBe(30 * 1000);
    expect(backoffDelayMs(2)).toBe(60 * 1000);
    expect(backoffDelayMs(100)).toBe(3600 * 1000);
  });

  it('delivers a signed event and marks it sent', async () => {
    transport.post.mockResolvedValueOnce({ status: 200 });
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    const res = await service.pollOnce();
    expect(res).toEqual({ processed: 1, sent: 1 });
    const call = transport.post.mock.calls[0][0];
    expect(call.url).toBe('https://example.com/hooks/dock');
    expect(JSON.parse(call.body)).toMatchObject({ id: 'evt-1', type: 'dock.ready', dock: { id: 'd-1', state: 'ready' } });
    expect(verifyWebhook(SECRET, call.headers[WEBHOOK_SIGNATURE_HEADER], call.body)).toBe(true);
    expect(inserted[0]).toMatchObject({ eventId: 'evt-1', endpointId: 'ep-1', status: 200, error: null });
    expect(updated[updated.length - 1]).toMatchObject({ status: 'sent' });
  });

  it('refuses to POST when the endpoint host now resolves to a private address', async () => {
    webhooks.assertDeliverableUrl.mockRejectedValueOnce(new Error('Url must not target a private or local network address'));
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(transport.post).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ status: null, error: expect.stringContaining('private') });
  });

  it('retries with the identical body and event id', async () => {
    transport.post.mockRejectedValueOnce(new Error('socket hangup'));
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(updated[updated.length - 1]).toMatchObject({ attempts: 1 });
    expect((updated[updated.length - 1] as { status?: string }).status).not.toBe('sent');

    transport.post.mockResolvedValueOnce({ status: 200 });
    const firstBody = transport.post.mock.calls[0][0].body;
    selectDue([deliveryRow({ attempts: 1 })]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 1 });
    expect(transport.post.mock.calls[1][0].body).toBe(firstBody);
  });

  it('disables the endpoint on 410 and parks the delivery', async () => {
    transport.post.mockResolvedValueOnce({ status: 410 });
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(webhooks.disableEndpoint).toHaveBeenCalledWith('ep-1');
    expect(updated[updated.length - 1]).toMatchObject({ status: 'gave_up' });
    selectDue([]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 0, sent: 0 });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('parks permanent receiver rejections without retrying', async () => {
    transport.post.mockResolvedValueOnce({ status: 404 });
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(updated[updated.length - 1]).toMatchObject({ status: 'gave_up' });
    expect(webhooks.disableEndpoint).not.toHaveBeenCalled();
  });

  it('skips rate-limited endpoints without posting', async () => {
    limits.hit.mockResolvedValueOnce({ allowed: false, count: 61 });
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(transport.post).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('parks deliveries with no backing event or endpoint', async () => {
    selectDue([deliveryRow()]);
    selectOne([]);
    selectOne([endpointRow()]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(transport.post).not.toHaveBeenCalled();
    expect(updated[updated.length - 1]).toMatchObject({ status: 'gave_up' });
  });

  it('leaves disabled endpoints alone', async () => {
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow({ disabled: true })]);
    await expect(service.pollOnce()).resolves.toEqual({ processed: 1, sent: 0 });
    expect(transport.post).not.toHaveBeenCalled();
    expect(updated[updated.length - 1]).toMatchObject({ status: 'gave_up' });
  });

  it('drops an overlapping tick instead of double-posting the same pending rows', async () => {
    let resolvePost: ((v: { status: number }) => void) | undefined;
    transport.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    selectDue([deliveryRow()]);
    selectOne([eventRow()]);
    selectOne([endpointRow()]);
    const first = service.pollOnce();
    await new Promise((r) => setTimeout(r, 0)); // drain microtasks until the first tick reaches the in-flight post
    const second = await service.pollOnce();
    expect(second).toEqual({ processed: 0, sent: 0 });
    expect(db.select).toHaveBeenCalledTimes(3); // due + event + endpoint, once total
    resolvePost?.({ status: 200 });
    await expect(first).resolves.toEqual({ processed: 1, sent: 1 });
  });

  it('builds stable payloads for signing', () => {
    const body = eventPayload(eventRow() as never);
    expect(JSON.parse(body)).toMatchObject({ id: 'evt-1', dock: { id: 'd-1', state: 'ready' } });
    expect(eventPayload(eventRow() as never)).toBe(body);
  });
});
