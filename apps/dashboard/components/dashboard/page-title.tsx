'use client';

import { usePathname } from 'next/navigation';
import { pageTitle } from '@/lib/page-title';

/** The only <title> in the app; root metadata sets none so Next never overwrites it. */
export function PageTitle() {
  return <title>{pageTitle(usePathname())}</title>;
}
