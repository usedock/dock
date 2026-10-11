import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module';

// Importing AppModule runs ConfigModule.forRoot, which validates the env; only the graph matters here.
vi.mock('./config/validate-env', () => ({ validateEnv: (env: Record<string, unknown>) => env }));

type Entry = Function | { forwardRef: () => Function } | { module: Function; imports?: Entry[] } | undefined;

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? moduleFiles(join(dir, e.name)) : e.name.endsWith('.module.ts') ? [join(dir, e.name)] : [],
  );
}

const controllersOf = (cls: Function): Function[] => Reflect.getMetadata('controllers', cls) ?? [];

/** Every module Nest would instantiate from AppModule, read from the decorators themselves. */
function reachable(): Set<Function> {
  const seen = new Set<Function>();
  const visit = (entry: Entry): void => {
    if (!entry) return;
    if ('forwardRef' in entry) return visit(entry.forwardRef());
    if ('module' in entry) {
      visit(entry.module);
      entry.imports?.forEach(visit);
      return;
    }
    if (seen.has(entry)) return;
    seen.add(entry);
    (Reflect.getMetadata('imports', entry) ?? []).forEach(visit);
  };
  visit(AppModule);
  return seen;
}

// A module with controllers that nothing imports mounts no routes (dock#131).
describe('AppModule', () => {
  it('reaches every module that declares controllers', async () => {
    const declared: Function[] = [];
    for (const file of moduleFiles(__dirname)) {
      for (const value of Object.values(await import(file))) {
        if (typeof value === 'function' && controllersOf(value).length) declared.push(value);
      }
    }
    expect(declared.map((m) => m.name)).toEqual(expect.arrayContaining(['DockTransfersModule', 'ConnectorTriggersModule', 'MailModule']));
    const seen = reachable();
    expect(declared.filter((m) => !seen.has(m)).map((m) => m.name)).toEqual([]);
  });
});
