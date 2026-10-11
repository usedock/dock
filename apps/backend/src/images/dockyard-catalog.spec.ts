import { DEFAULT_IMAGE } from '../database/schema/docks';
import { DOCKYARD_CATALOG, DOCKYARD_IMAGE_NAMES } from './catalog';

/*
 * Resync dockyard-catalog.json with the Dockyard source of truth after
 * usedock/docklet changes images/catalog.toml:
 *   1. For each [[image]] table copy name, description, arch and size_mib (as sizeMiB).
 *   2. Write a one-line `contents` summary from its base and setup script.
 *   3. Keep the order of the TOML and run this spec.
 */
describe('dockyard catalog', () => {
  it('has unique names that include the default image', () => {
    expect(new Set(DOCKYARD_IMAGE_NAMES).size).toBe(DOCKYARD_IMAGE_NAMES.length);
    expect(DOCKYARD_IMAGE_NAMES).toContain(DEFAULT_IMAGE);
  });

  it('lists the four Dockyard images', () => {
    expect(DOCKYARD_IMAGE_NAMES).toEqual(['ubuntu-24.04', 'node-22', 'python-3.12', 'browser']);
  });

  it('fills every field', () => {
    for (const image of DOCKYARD_CATALOG) {
      expect(image.description).not.toBe('');
      expect(image.contents).not.toBe('');
      expect(image.arch.length).toBeGreaterThan(0);
      expect(image.sizeMiB).toBeGreaterThan(0);
    }
  });
});
