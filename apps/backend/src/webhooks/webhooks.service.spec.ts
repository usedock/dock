import { ForbiddenException, HttpException } from '@nestjs/common';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { openValue } from '../environments/secrets';
import { MAX_ENDPOINTS_PER_ORG, WebhooksService } from './webhooks.service';
import { webhookDeliveries, webhookEvents } from '../database/schema';
import { vi } from 'vitest';

const KEY = Buffer.from('a'.repeat(64), 'hex');
const orgId = '11111111-1111-4111-8111-111111111111';
const endpointId = '22222222-2222-4222-8222-222222222222';
const owner = { id: 'u-owner', email: 'o@x.co', emailVerified: true, isInteractive: true };
const serviceKey = { id: 'u-owner', email: 'o@x.co', emailVerified: true, isInteractive: false };

const endpointRow = (overrides: Record<string, unknown> = {}) => ({
  id: endpointId,
  organizationId: orgId,
  name: 'Production automation',
  url: 'https://example.com/hooks/dock',
  events: ['dock.ready', 'dock.archived'],
  secret: { iv: 'aXY=', tag: 'bXY=', data: 'cXY=' },
  secretPrefix: 'deadbeef',
  disabled: false,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

describe('WebhooksService', () => {
  let db: any;
  let orgs: any;
  let config: any;
  let service: WebhooksService;
  const selectRows = (rows: unknown[]) => {
    const p = Promise.resolve(rows);
    const terminal = { limit: () => p, then: p.then.bind(p) };
    return {
      from: () => ({
        where: () => ({ orderBy: () => terminal, limit: () => p, then: p.then.bind(p) }),
      }),
    };
  };
  const insertRows = (rows: unknown[]) => ({ values: () => ({ returning: () => Promise.resolve(rows) }) });

  async function catchErr(promise: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      return { status: http.getStatus(), body: http.getResponse() };
    }
    throw new Error('expected rejection');
  }

  let resolveHost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(() => ({ where: () => Promise.resolve([]) })) };
    vi.clearAllMocks();
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    config = { getOrThrow: vi.fn().mockReturnValue('a'.repeat(64)) };
    resolveHost = vi.fn().mockResolvedValue(['93.184.216.34']);
    service = new WebhooksService(db as never, orgs as never, config as never, { resolveHost });
    vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('returns the secret once alongside metadata', async () => {
    db.select.mockReturnValueOnce(selectRows([]));
    db.insert.mockReturnValueOnce(insertRows([endpointRow()]));
    const created = await service.create(owner as never, orgId, 'Production automation', 'https://example.com/hooks/dock', [
      'dock.ready',
      'dock.archived',
    ] as never);
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.secretPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(created).not.toHaveProperty('sealed');
  });

  it('seals the stored secret so only the create response reveals it', async () => {
    db.select.mockReturnValueOnce(selectRows([]));
    let stored: any;
    db.insert.mockImplementation(() => ({
      values: (values: any) => {
        stored = values;
        return { returning: () => Promise.resolve([endpointRow({ secret: values.secret, secretPrefix: values.secretPrefix })]) };
      },
    }));
    const created = await service.create(owner as never, orgId, 'Hooks', 'https://example.com/hooks/dock', ['dock.ready'] as never);
    expect(stored.secret.data).not.toContain(created.secret);
    expect(openValue(KEY, stored.secret)).toBe(created.secret);
    db.select.mockReturnValueOnce(selectRows([endpointRow({ secret: stored.secret, secretPrefix: stored.secretPrefix })]));
    const listed = await service.list(owner.id, orgId);
    expect(listed[0]).not.toHaveProperty('secret');
    expect(listed[0]).not.toHaveProperty('sealed');
  });

  it('rejects non-https and non-443 urls without storing anything', async () => {
    for (const url of ['http://example.com/hooks/dock', 'https://example.com:8443/hooks/dock']) {
      const err = await catchErr(service.create(owner as never, orgId, 'Hooks', url, ['dock.ready'] as never));
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: 'validation_error' });
    }
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects urls whose host resolves to a private or metadata address', async () => {
    for (const addresses of [['169.254.169.254'], ['10.0.0.5'], ['192.168.1.1'], ['127.0.0.1'], ['::1']]) {
      resolveHost.mockResolvedValueOnce(addresses);
      const err = await catchErr(
        service.create(owner as never, orgId, 'Hooks', 'https://internal.example.com/hooks/dock', ['dock.ready'] as never),
      );
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: 'validation_error' });
    }
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('re-resolves at delivery time so a host re-pointed at a private range is refused', async () => {
    await expect(service.assertDeliverableUrl('https://hooks.example.com/dock')).resolves.toBeUndefined();
    resolveHost.mockResolvedValueOnce(['10.0.0.5']);
    const err = await catchErr(service.assertDeliverableUrl('https://hooks.example.com/dock'));
    expect(err.status).toBe(400);
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it('rejects raw private-ip and loopback literals without resolving DNS', async () => {
    for (const url of ['https://169.254.169.254/hooks', 'https://127.0.0.1/hooks', 'https://10.1.2.3/hooks', 'https://localhost/hooks']) {
      const err = await catchErr(service.create(owner as never, orgId, 'Hooks', url, ['dock.ready'] as never));
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: 'validation_error' });
    }
    expect(resolveHost).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('enforces the per-organization endpoint cap', async () => {
    db.select.mockReturnValueOnce(selectRows(Array.from({ length: MAX_ENDPOINTS_PER_ORG }, (_, i) => ({ id: `e-${i}` }))));
    const err = await catchErr(
      service.create(owner as never, orgId, 'One too many', 'https://example.com/hooks/dock', ['dock.ready'] as never),
    );
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: 'endpoints_exceeded' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects service-key writes without touching the database', async () => {
    const err = await catchErr(
      service.create(serviceKey as never, orgId, 'Hooks', 'https://example.com/hooks/dock', ['dock.ready'] as never),
    );
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: 'session_required' });
    expect(orgs.requireMembership).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('propagates member and non-member denials', async () => {
    orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'nope' }));
    const memberErr = await catchErr(
      service.create(owner as never, orgId, 'Hooks', 'https://example.com/hooks/dock', ['dock.ready'] as never),
    );
    expect(memberErr.status).toBe(403);
    orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
    const listErr = await catchErr(service.list('u-stranger', orgId));
    expect(listErr.body).toMatchObject({ code: 'organization_not_found' });
  });
  it('returns 404 for unknown endpoint ids', async () => {
    db.select.mockReturnValueOnce(selectRows([]));
    const getErr = await catchErr(service.get(owner.id, orgId, endpointId));
    expect(getErr.status).toBe(404);
    expect(getErr.body).toMatchObject({ code: 'webhook_endpoint_not_found' });
    db.select.mockReturnValueOnce(selectRows([]));
    const removeErr = await catchErr(service.remove(owner as never, orgId, endpointId));
    expect(removeErr.status).toBe(404);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('removes an owned endpoint', async () => {
    db.select.mockReturnValueOnce(selectRows([endpointRow()]));
    await expect(service.remove(owner as never, orgId, endpointId)).resolves.toEqual({ removed: true });
    expect(db.delete).toHaveBeenCalled();
  });

  it('records outbox events and never throws on write failure', async () => {
    db.insert.mockReturnValueOnce(insertRows([{ id: 'evt-1' }]));
    await expect(
      service.record({ type: 'dock.ready', dockId: 'd-1', organizationId: orgId, workspaceId: 'w-1', state: 'ready' }),
    ).resolves.toEqual({ id: 'evt-1' });
    db.insert.mockReturnValueOnce({ values: () => ({ returning: () => Promise.reject(new Error('db down')) }) });
    await expect(
      service.record({ type: 'dock.ready', dockId: 'd-1', organizationId: orgId, workspaceId: 'w-1', state: 'ready' }),
    ).resolves.toBeNull();
  });

  it('refuses to record unknown event types', async () => {
    await expect(
      service.record({ type: 'dock.exploded' as never, dockId: 'd-1', organizationId: orgId, workspaceId: 'w-1', state: 'x' }),
    ).resolves.toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('fans out one delivery per subscribed endpoint', async () => {
    const calls: Array<[unknown, unknown]> = [];
    db.insert.mockImplementation((table: unknown) => ({
      values: (values: unknown) => {
        calls.push([table, values]);
        if (table === webhookEvents) return { returning: () => Promise.resolve([{ id: 'evt-9' }]) };
        return { onConflictDoNothing: () => Promise.resolve([]) };
      },
    }));
    db.select.mockReturnValueOnce(selectRows([endpointRow(), endpointRow({ id: 'ep-2' })]));
    await expect(
      service.record({ type: 'dock.ready', dockId: 'd-1', organizationId: orgId, workspaceId: 'w-1', state: 'ready' }),
    ).resolves.toEqual({ id: 'evt-9' });
    const fanout = calls.find(([table]) => table === webhookDeliveries);
    expect(fanout?.[1]).toEqual([
      { eventId: 'evt-9', endpointId },
      { eventId: 'evt-9', endpointId: 'ep-2' },
    ]);
  });

  it('lists delivery attempts for members', async () => {
    db.select.mockReturnValueOnce(selectRows([endpointRow()]));
    const attempt = { id: 'a-1', event: 'dock.ready', status: 200, error: null };
    const joined = vi.fn();
    db.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: (...args: unknown[]) => {
          joined(...args);
          return { where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([attempt]) }) }) };
        },
      }),
    });
    await expect(service.deliveries(owner.id, orgId, endpointId)).resolves.toEqual([attempt]);
    // The attempts query joins webhook_events to expose the event type.
    expect(joined).toHaveBeenCalledTimes(1);
    expect(db.select.mock.calls[1][0]).toMatchObject({ event: webhookEvents.type, error: expect.anything() });
  });

  it('hides foreign endpoints as 404 on deliveries', async () => {
    db.select.mockReturnValueOnce(selectRows([endpointRow({ organizationId: '99999999-9999-4999-8999-999999999999' })]));
    const err = await catchErr(service.deliveries(owner.id, orgId, endpointId));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ code: 'webhook_endpoint_not_found' });
  });
});
