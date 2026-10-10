import { docs } from '@/.source/server';
import { loader } from 'fumadocs-core/source';

// Docs live at the site root; there is no /docs prefix on this host.
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
