import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// Prebuilt index served as a static file, so the site can be exported.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, { language: 'english' });
