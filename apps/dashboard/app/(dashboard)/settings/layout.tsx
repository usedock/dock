'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const SECTIONS = [
  { href: '/settings/profile', value: 'profile', label: 'Profile' },
  { href: '/settings/connections', value: 'connections', label: 'Connections' },
  { href: '/settings/organization', value: 'organization', label: 'Organization' },
  { href: '/settings/workspaces', value: 'workspaces', label: 'Workspaces' },
  { href: '/settings/safety', value: 'safety', label: 'Safety' },
];

/** Settings group: identity, org membership, workspaces, retention, danger zone. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))?.value ?? 'profile';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your profile and sign-ins, plus the selected organization&apos;s members, workspaces, and retention.</p>
      </div>
      <Tabs value={active}>
        <TabsList aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.value} value={s.value} nativeButton={false} render={<Link href={s.href} />}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex max-w-4xl flex-col gap-6">{children}</div>
    </div>
  );
}
