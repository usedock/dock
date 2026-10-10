import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Version of an installed SDK, found by walking up from its entry file. */
export function sdkVersion(pkg: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (json.name === pkg) return `sdk ${json.version}`;
    }
    const parent = dirname(dir);
    if (parent === dir) return 'sdk unknown';
    dir = parent;
  }
}
