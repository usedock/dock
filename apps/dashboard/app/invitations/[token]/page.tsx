import { redirect } from 'next/navigation';
import { getDashboardSession } from '@/lib/session';
import { VerifyEmailBanner } from '@/components/dashboard/verify-email-banner';
import { InvitationCard } from '@/components/dashboard/invitation-card';

/** Accept or decline page for an emailed invitation link; sign-in comes first and returns here. */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getDashboardSession();
  if (!session) redirect(`/auth/login?next=${encodeURIComponent(`/invitations/${token}`)}`);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
      {session.user.emailVerified === false && (
        <div className="w-full max-w-md">
          <VerifyEmailBanner email={session.user.email} />
        </div>
      )}
      <InvitationCard token={token} email={session.user.email} />
    </div>
  );
}
