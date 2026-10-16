'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { pageTitle } from '@/lib/page-title';

/** Sets the tab title from the route; pages are client components so metadata templates never apply. */
export function PageTitle() {
  const pathname = usePathname();
  useEffect(() => {
    document.title = pageTitle(pathname);
  }, [pathname]);
  return null;
}
