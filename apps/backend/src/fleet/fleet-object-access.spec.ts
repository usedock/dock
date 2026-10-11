import { ForbiddenException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FleetObjectAccess } from './fleet-object-access';

/** Each select() consumes the next scripted result; every chain step returns the same builder. */
function scriptedDb(results: Array<Array<Record<string, unknown>>>, inserted: Array<Record<string, unknown>> = []) {
  const queue = [...results];
  const orderBy = vi.fn();
  const select = vi.fn(() => {
    const rows = queue.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const step of ['from', 'innerJoin', 'where']) builder[step] = () => builder;
    builder.orderBy = (...args: unknown[]) => (orderBy(...args), builder);
    builder.limit = () => Promise.resolve(rows);
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return builder;
  });
  const insert = vi.fn(() => ({
    values: (value: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({ returning: () => Promise.resolve(inserted.length ? [value] : []) }),
    }),
  }));
  return { select, insert, orderBy };
}

const HIT = [{ id: 'x' }];

describe('FleetObjectAccess', () => {
  const build = (results: Array<Array<Record<string, unknown>>>, inserted: Array<Record<string, unknown>> = []) => {
    const db = scriptedDb(results, inserted);
    return { db, access: new FleetObjectAccess(db as never) };
  };

  describe('reads', () => {
    it('allows a snapshot of a dock placed on the host', async () => {
      const { db, access } = build([HIT]);
      await expect(access.assertRead('host-a', 'gen-1')).resolves.toBeUndefined();
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('allows a generation named by a queued or claimed command on the host', async () => {
      const { access } = build([[], HIT]);
      await expect(access.assertRead('host-a', 'gen-1')).resolves.toBeUndefined();
    });

    it('refuses a generation that belongs to another host and is not being loaded here', async () => {
      const { access } = build([[], []]);
      await expect(access.assertRead('host-a', 'gen-of-b')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('reads of a generation bound to an in-flight capture', () => {
    const BOUND = { generationId: 'gen-1', hostId: 'host-a', commandId: 'cap1' };

    it('allows the bound host while its command is claimed', async () => {
      // not owned, no command names it, bound row found, bound command still claimed
      const { access } = build([[], [], [BOUND], HIT]);
      await expect(access.assertRead('host-a', 'gen-1')).resolves.toBeUndefined();
    });

    it('refuses another host', async () => {
      const { access } = build([[], [], [BOUND]]);
      await expect(access.assertRead('host-b', 'gen-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses the bound host once its command finished or failed', async () => {
      const { access } = build([[], [], [BOUND], []]);
      await expect(access.assertRead('host-a', 'gen-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an id that is not bound', async () => {
      const { access } = build([[], [], []]);
      await expect(access.assertRead('host-a', 'gen-unbound')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('writes', () => {
    const BOUND = { generationId: 'gen-1', hostId: 'host-a', commandId: 'cap1' };

    it('binds a new generation to the first writer during its claimed snapshot.create', async () => {
      // not bound, not recorded (snapshot, template), claimed capture found, insert wins
      const { db, access } = build([[], [], [], [{ id: 'cap1' }]], [{ x: 1 }]);
      await expect(access.assertWrite('host-a', 'gen-new')).resolves.toBeUndefined();
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('picks the most recently claimed unbound capture', async () => {
      const { db, access } = build([[], [], [], [{ id: 'cap-newest' }]], [{ x: 1 }]);
      await access.assertWrite('host-a', 'gen-new');
      expect(db.orderBy).toHaveBeenCalledTimes(1);
      const order = new PgDialect().sqlToQuery(db.orderBy.mock.calls[0][0] as SQL);
      expect(order.sql).toContain('"claimed_at" desc');
    });

    it('lets the binding command and host keep writing its generation', async () => {
      const { db, access } = build([[BOUND], HIT]);
      await expect(access.assertWrite('host-a', 'gen-1')).resolves.toBeUndefined();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses another host writing or deleting a bound generation', async () => {
      const { access } = build([[BOUND]]);
      await expect(access.assertWrite('host-b', 'gen-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses the bound host once its command is no longer claimed', async () => {
      const { access } = build([[BOUND], []]);
      await expect(access.assertWrite('host-a', 'gen-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('treats a recorded generation as immutable even for the host that reported it', async () => {
      // not bound; a snapshot row records it, so ownership no longer grants writes
      const { db, access } = build([[], HIT]);
      await expect(access.assertWrite('host-a', 'gen-recorded')).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses overwriting a template generation', async () => {
      const { access } = build([[], [], HIT]);
      await expect(access.assertWrite('host-a', 'tpl-gen')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a write when the host has no unbound claimed capture', async () => {
      const { access } = build([[], [], [], []]);
      await expect(access.assertWrite('host-a', 'gen-new')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses the loser of a race for the id unless it is the recorded winner', async () => {
      const { access } = build([[], [], [], [{ id: 'cap1' }], [{ generationId: 'gen-new', hostId: 'host-b', commandId: 'capB' }]]);
      await expect(access.assertWrite('host-a', 'gen-new')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
