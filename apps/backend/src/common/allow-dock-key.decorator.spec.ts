import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DocksController } from '../docks/docks.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { StatsController } from '../stats/stats.controller';
import { ALLOW_DOCK_KEY } from './allow-dock-key.decorator';

const allowed = (controller: { prototype: object }, method: string) =>
  Reflect.getMetadata(ALLOW_DOCK_KEY, (controller.prototype as Record<string, object>)[method]) === true;

describe('routes open to dock-bound keys (allowlist)', () => {
  it('allows only own-dock reads and port self-service', () => {
    for (const m of ['getById', 'listPorts', 'exposePort', 'removePort']) expect(allowed(DocksController, m), m).toBe(true);
    expect(allowed(StatsController, 'getStats')).toBe(true);
  });

  it('denies dock create, update, delete, lifecycle, branch, exec and terminal', () => {
    for (const m of ['create', 'list', 'update', 'remove', 'stop', 'resume', 'branch', 'exec', 'terminal']) {
      expect(allowed(DocksController, m), m).toBe(false);
    }
  });

  it('denies notifications', () => {
    for (const m of ['listInbox', 'markAllRead', 'markRead', 'getPreferences', 'updateOrgPreference', 'updatePersonalPreference']) {
      expect(allowed(NotificationsController, m), m).toBe(false);
    }
  });

  it('keeps the allowlist to exactly these decorated handlers', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.controller.ts')) files.push(p);
      }
    };
    walk(join(__dirname, '..'));
    const hits = files.flatMap((p) => {
      const count = (readFileSync(p, 'utf8').match(/@AllowDockKey\(\)/g) ?? []).length;
      return Array<string>(count).fill(basename(p));
    });
    expect(hits.sort()).toEqual(['docks.controller.ts', 'docks.controller.ts', 'docks.controller.ts', 'docks.controller.ts', 'stats.controller.ts']);
  });
});
