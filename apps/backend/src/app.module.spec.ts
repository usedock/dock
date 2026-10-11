import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type ModuleInfo = { imports: string[]; hasControllers: boolean };

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? moduleFiles(join(dir, e.name)) : e.name.endsWith('.module.ts') ? [join(dir, e.name)] : [],
  );
}

function readModules(): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>();
  for (const file of moduleFiles(__dirname)) {
    const src = readFileSync(file, 'utf8');
    const name = /export class (\w+Module)\b/.exec(src)?.[1];
    if (!name) continue;
    const list = /imports:\s*\[([\s\S]*?)\]\s*,?\s*\n\s*(?:controllers|providers|exports|\})/.exec(src)?.[1] ?? '';
    const imports = [...list.matchAll(/\b(\w+Module)\b/g)].map((m) => m[1]);
    const hasControllers = /controllers:\s*\[\s*\w/.test(src);
    modules.set(name, { imports, hasControllers });
  }
  return modules;
}

// A module with controllers that nothing imports mounts no routes (dock#131).
describe('AppModule', () => {
  it('reaches every module that declares controllers', () => {
    const modules = readModules();
    const seen = new Set<string>();
    const queue = ['AppModule'];
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...(modules.get(name)?.imports ?? []));
    }
    const unreachable = [...modules].filter(([name, m]) => m.hasControllers && !seen.has(name)).map(([name]) => name);
    expect(modules.get('DockTransfersModule')?.hasControllers).toBe(true);
    expect(unreachable).toEqual([]);
  });
});
