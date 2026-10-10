import { HttpException } from '@nestjs/common';
import { vi } from 'vitest';
import { hashToken } from '../crypto/tokens';
import { organizationInvitations, organizationMembers } from '../database/schema';
import { InvitationsService } from './invitations.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const INV = '33333333-3333-4333-8333-333333333333';
const future = () => new Date(Date.now() + 60_000);

/** Chainable fake: every builder method returns itself and awaiting yields the next queued rows. */
function chain(queue: unknown[][]) {
  const node: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === 'then') {
        const rows = queue.shift() ?? [];
        return (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      }
      return () => node;
    },
    apply: () => node,
  });
  return node;
}

describe('InvitationsService', () => {
  let queue: unknown[][];
  let writes: Array<{ op: string; table: unknown; vals: any }>;
  let db: any;
  let orgs: any;
  let mail: { send: ReturnType<typeof vi.fn> };
  let service: InvitationsService;

  beforeEach(() => {
    queue = [];
    writes = [];
    const tx: any = {
      execute: vi.fn().mockResolvedValue([]),
      select: vi.fn(() => chain(queue)),
      insert: vi.fn((table: unknown) => ({
        values: (vals: any) => {
          writes.push({ op: 'insert', table, vals });
          return chain(queue);
        },
      })),
      update: vi.fn((table: unknown) => ({
        set: (vals: any) => {
          writes.push({ op: 'update', table, vals });
          return chain(queue);
        },
      })),
    };
    db = { ...tx, transaction: vi.fn(async (fn: any) => fn(tx)) };
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    mail = { send: vi.fn().mockResolvedValue({ messageId: null }) };
    const config = { get: (k: string) => (k === 'PUBLIC_APP_URL' ? 'https://dash.example.com' : undefined) };
    service = new InvitationsService(db, orgs, mail as never, config as never);
  });

  async function catchErr(p: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return { status: (err as HttpException).getStatus(), body: (err as HttpException).getResponse() };
    }
    throw new Error('expected rejection');
  }

  const user = (over: Partial<{ id: string; email: string; emailVerified: boolean }> = {}) => ({
    id: 'u2',
    email: 'bee@example.com',
    emailVerified: true,
    isInteractive: true,
    ...over,
  });

  describe('invite', () => {
    it('creates a pending invitation and emails a link with the raw token, storing only its hash', async () => {
      queue.push([{ id: 'org', name: 'Acme', seats: 5 }], [{ userId: 'u1', email: 'a@example.com' }], [], []);
      const out = await service.invite('u1', ORG, { email: ' Bee@Example.com ' });
      expect(out).toEqual({ status: 'accepted' });
      const insert = writes.find((w) => w.op === 'insert' && w.table === organizationInvitations)!;
      expect(insert.vals).toMatchObject({ organizationId: ORG, email: 'bee@example.com', role: 'member' });
      const sent = mail.send.mock.calls[0][0];
      const token = sent.context.inviteUrl.split('/invitations/')[1];
      expect(sent.context.inviteUrl).toBe(`https://dash.example.com/invitations/${token}`);
      expect(insert.vals.tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(insert.vals)).not.toContain(token);
      expect(insert.vals.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    });

    it('answers identically for an existing member but sends nothing and inserts nothing', async () => {
      queue.push([{ id: 'org', name: 'Acme', seats: 5 }], [{ userId: 'u2', email: 'Bee@example.com' }], []);
      const out = await service.invite('u1', ORG, { email: 'bee@example.com' });
      expect(out).toEqual({ status: 'accepted' });
      expect(writes).toHaveLength(0);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('refreshes an existing pending invitation instead of inserting a second one', async () => {
      queue.push(
        [{ id: 'org', name: 'Acme', seats: 2 }],
        [{ userId: 'u1', email: 'a@example.com' }],
        [{ id: INV, email: 'bee@example.com' }],
        [{ id: INV }],
      );
      await service.invite('u1', ORG, { email: 'bee@example.com', role: 'admin' });
      expect(writes.map((w) => w.op)).toEqual(['update']);
      expect(writes[0].vals).toMatchObject({ role: 'admin' });
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('counts pending invitations toward seats for members and strangers alike', async () => {
      for (const members of [
        [{ userId: 'u1', email: 'a@example.com' }],
        [{ userId: 'u2', email: 'bee@example.com' }],
      ]) {
        queue.push([{ id: 'org', name: 'Acme', seats: 2 }], members, [{ id: INV, email: 'other@example.com' }]);
        const err = await catchErr(service.invite('u1', ORG, { email: 'bee@example.com' }));
        expect(err.status).toBe(409);
        expect(err.body).toMatchObject({ code: 'seats_exceeded' });
      }
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('requires an owner to invite an owner', async () => {
      orgs.requireMembership.mockImplementation(async (_o: string, _u: string, min: string) => {
        if (min === 'owner') throw new HttpException({ code: 'forbidden' }, 403);
        return { role: 'admin' };
      });
      const err = await catchErr(service.invite('u1', ORG, { email: 'bee@example.com', role: 'owner' }));
      expect(err.status).toBe(403);
    });

    it('requires an owner to refresh a pending owner invitation even at a lower role', async () => {
      orgs.requireMembership.mockImplementation(async (_o: string, _u: string, min: string) => {
        if (min === 'owner') throw new HttpException({ code: 'forbidden' }, 403);
        return { role: 'admin' };
      });
      queue.push(
        [{ id: 'org', name: 'Acme', seats: 5 }],
        [{ userId: 'u1', email: 'a@example.com' }],
        [{ id: INV, email: 'bee@example.com', role: 'owner' }],
      );
      const err = await catchErr(service.invite('u1', ORG, { email: 'bee@example.com', role: 'member' }));
      expect(err.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('rejects a userId that does not exist', async () => {
      queue.push([]);
      const err = await catchErr(service.invite('u1', ORG, { userId: '44444444-4444-4444-8444-444444444444' }));
      expect(err.status).toBe(404);
    });

    it('resolves a userId to that account email and still only invites', async () => {
      queue.push(
        [{ id: 'u2', email: 'Bee@Example.com' }],
        [{ id: 'org', name: 'Acme', seats: 5 }],
        [{ userId: 'u1', email: 'a@example.com' }],
        [],
        [],
      );
      const out = await service.invite('u1', ORG, { userId: '44444444-4444-4444-8444-444444444444' });
      expect(out).toEqual({ status: 'accepted' });
      expect(writes.find((w) => w.table === organizationMembers)).toBeUndefined();
      expect(mail.send.mock.calls[0][0].to).toBe('bee@example.com');
    });
  });

  describe('admin management', () => {
    it('list, revoke and resend all require an admin', async () => {
      orgs.requireMembership.mockRejectedValue(new HttpException({ code: 'forbidden' }, 403));
      expect((await catchErr(service.list('u3', ORG))).status).toBe(403);
      expect((await catchErr(service.revoke('u3', ORG, INV))).status).toBe(403);
      expect((await catchErr(service.resend('u3', ORG, INV))).status).toBe(403);
      expect(orgs.requireMembership).toHaveBeenCalledWith(ORG, 'u3', 'admin');
    });

    it('revoke of an unknown or consumed invitation reads invitation_not_found', async () => {
      queue.push([]);
      const err = await catchErr(service.revoke('u1', ORG, INV));
      expect(err.body).toMatchObject({ code: 'invitation_not_found' });
    });

    it('revoke marks the invitation revoked', async () => {
      queue.push([{ id: INV }]);
      await expect(service.revoke('u1', ORG, INV)).resolves.toEqual({ revoked: true });
      expect(writes[0].vals.revokedAt).toBeInstanceOf(Date);
    });

    it('resend rotates the token hash, extends expiry and emails the new link', async () => {
      const inv = {
        id: INV,
        email: 'bee@example.com',
        role: 'member',
        organizationId: ORG,
        expiresAt: new Date(0),
        createdAt: new Date(0),
      };
      queue.push(
        [{ id: 'org', name: 'Acme', seats: 5 }],
        [inv],
        [{ userId: 'u1' }],
        [inv],
        [{ ...inv, expiresAt: future() }],
      );
      await service.resend('u1', ORG, INV);
      const token = mail.send.mock.calls[0][0].context.inviteUrl.split('/invitations/')[1];
      expect(writes[0].vals.tokenHash).toBe(hashToken(token));
      expect(mail.send.mock.calls[0][0].to).toBe('bee@example.com');
    });
  });

  describe('accept and decline', () => {
    const pending = (over: Record<string, unknown> = {}) => ({
      id: INV,
      organizationId: ORG,
      email: 'bee@example.com',
      role: 'admin',
      acceptedAt: null,
      revokedAt: null,
      expiresAt: future(),
      ...over,
    });

    it('accept adds the membership with the invited role and consumes the invitation', async () => {
      queue.push([pending()], [pending()], [{ id: 'org', seats: 2 }], [], [{ userId: 'u1' }], [], [{ id: INV }]);
      const out = await service.accept(user(), { token: 'tok' });
      expect(out).toEqual({ organizationId: ORG, role: 'admin' });
      expect(writes.find((w) => w.table === organizationMembers)!.vals).toMatchObject({ userId: 'u2', role: 'admin' });
      expect(writes.find((w) => w.table === organizationInvitations)!.vals.acceptedAt).toBeInstanceOf(Date);
    });

    it('accept loses cleanly when the invitation was consumed concurrently', async () => {
      queue.push([pending()], [pending()], [{ id: 'org', seats: 2 }], [], [{ userId: 'u1' }], [], []);
      const err = await catchErr(service.accept(user(), { token: 'tok' }));
      expect(err.body).toMatchObject({ code: 'invitation_not_found' });
    });

    it('accept respects seat limits under the lock', async () => {
      queue.push([pending()], [pending()], [{ id: 'org', seats: 1 }], [], [{ userId: 'u1' }]);
      const err = await catchErr(service.accept(user(), { token: 'tok' }));
      expect(err.body).toMatchObject({ code: 'seats_exceeded' });
      expect(writes).toHaveLength(0);
    });

    it.each([
      ['unknown', []],
      ['expired', [pending({ expiresAt: new Date(Date.now() - 1000) })]],
      ['revoked', [pending({ revokedAt: new Date() })]],
      ['accepted', [pending({ acceptedAt: new Date() })]],
      ['addressed to someone else', [pending({ email: 'other@example.com' })]],
    ])('rejects a %s token with the same error', async (_label, rows) => {
      queue.push(rows as unknown[]);
      const err = await catchErr(service.accept(user(), { token: 'tok' }));
      expect(err.status).toBe(404);
      expect(err.body).toMatchObject({ code: 'invitation_not_found' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects an unverified email without touching the database', async () => {
      const err = await catchErr(service.accept(user({ emailVerified: false }), { token: 'tok' }));
      expect(err.body).toMatchObject({ code: 'invitation_not_found' });
      expect(db.select).not.toHaveBeenCalled();
      await expect(service.listForUser(user({ emailVerified: false }))).resolves.toEqual([]);
    });

    it('decline revokes the invitation for the addressee only', async () => {
      queue.push([pending()], [pending()], []);
      await expect(service.decline(user(), { id: INV })).resolves.toEqual({ declined: true });
      expect(writes[0].vals.revokedAt).toBeInstanceOf(Date);
      queue.push([pending({ email: 'other@example.com' })]);
      const err = await catchErr(service.decline(user(), { id: INV }));
      expect(err.body).toMatchObject({ code: 'invitation_not_found' });
    });
  });
});
