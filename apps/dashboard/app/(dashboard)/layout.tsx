import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { getDashboardSession } from '@/lib/session';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { PendingInvitationsNotice } from '@/components/dashboard/pending-invitations-notice';
import { VerifyEmailBanner } from '@/components/dashboard/verify-email-banner';
import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { OrgProvider } from '@/components/dashboard/org-context';
import { CommandPaletteProvider, CommandPaletteTrigger } from '@/components/dashboard/command-palette';

/** Session-gated shell. Auth routes live outside it under app/auth. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getDashboardSession();
  if (!session) redirect('/auth/login');

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <SidebarProvider>
        <OrgProvider>
          <CommandPaletteProvider>
            <AppSidebar userEmail={session.user.email} />
            <SidebarInset>
              <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger aria-label="Toggle sidebar" />
                <Separator orientation="vertical" className="h-4" />
                <CommandPaletteTrigger />
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" nativeButton={false} render={<Link href="/docks?new=1" />}>
                    <Plus />
                    New dock
                  </Button>
                </div>
              </header>
              <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">{session.user.emailVerified === false && <VerifyEmailBanner email={session.user.email} />}
              {session.user.emailVerified !== false && <PendingInvitationsNotice />}
              {children}</div>
            </SidebarInset>
          </CommandPaletteProvider>
        </OrgProvider>
      </SidebarProvider>
    </div>
  );
}
