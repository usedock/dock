'use client';

import { useEffect, useState } from 'react';
import { MailPlus } from 'lucide-react';
import { getDefaultApi } from '@/lib/dock-api';
import type { MyInvitation } from '@/lib/dock-api';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** Lists organization invitations waiting for the signed-in user. */
export function PendingInvitationsNotice() {
  const [api] = useState(getDefaultApi);
  const [invitations, setInvitations] = useState<MyInvitation[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listMyInvitations().then(setInvitations).catch(() => setInvitations([]));
  }, [api]);

  async function respond(invitation: MyInvitation, kind: 'accept' | 'decline') {
    setBusy(true);
    try {
      if (kind === 'accept') {
        await api.acceptMyInvitation(invitation.id);
        window.location.reload();
        return;
      }
      await api.declineMyInvitation(invitation.id);
    } catch {
      // The re-read below drops stale invitations and keeps ones that could not be accepted.
    }
    setInvitations(await api.listMyInvitations().catch(() => []));
    setBusy(false);
  }

  return (
    <>
      {invitations.map((invitation) => (
        <Alert key={invitation.id}>
          <MailPlus />
          <AlertTitle>Invitation to {invitation.organizationName}</AlertTitle>
          <AlertDescription>You were invited to join as {invitation.role}.</AlertDescription>
          <AlertAction>
            <Button size="sm" disabled={busy} onClick={() => respond(invitation, 'accept')}>
              Accept
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => respond(invitation, 'decline')}>
              Decline
            </Button>
          </AlertAction>
        </Alert>
      ))}
    </>
  );
}
