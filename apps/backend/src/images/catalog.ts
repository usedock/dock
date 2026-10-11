import raw from './dockyard-catalog.json';

export interface CatalogImage {
  name: string;
  description: string;
  arch: string[];
  sizeMiB: number;
  contents: string;
}

// Mirror of usedock/docklet images/catalog.toml; resync steps are in dockyard-catalog.spec.ts.
export const DOCKYARD_CATALOG: readonly CatalogImage[] = raw.images;
export const DOCKYARD_IMAGE_NAMES: readonly string[] = DOCKYARD_CATALOG.map((image) => image.name);
