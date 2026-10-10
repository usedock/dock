'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getDefaultApi } from '@/lib/dock-api';
import type { MyInvitation } from '@/lib/dock-api';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; invitation: MyInvitation }
  | { kind: 'invalid' }
  | { kind: 'declined' };

/** Shows the invitation addressed to the signed-in user with accept and decline actions. */
export function InvitationCard({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [api] = useState(getDefaultApi);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getInvitation(token)
      .then((invitation) => setState({ kind: 'ready', invitation }))
      .catch(() => setState({ kind: 'invalid' }));
  }, [api, token]);

  async function act(kind: 'accept' | 'decline') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'accept') {
        await api.acceptInvitation(token);
        router.push('/');
        return;
      }
      await api.declineInvitation(token);
      setState({ kind: 'declined' });
    } catch {
      setError(
        kind === 'accept' ? 'Could not accept the invitation. The organization may be full.' : 'Could not decline the invitation.',
      );
    } finally {
      setBusy(false);
    }
  }

  const home = (
    <CardFooter>
      <Button nativeButton={false} variant="outline" render={<Link href="/" />}>
        Go to dashboard
      </Button>
    </CardFooter>
  );

  return (
    <Card className="w-full max-w-md">
      {state.kind === 'loading' ? (
        <CardHeader>
          <CardTitle>Loading invitation</CardTitle>
        </CardHeader>
      ) : state.kind === 'invalid' ? (
        <>
          <CardHeader>
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>
              This invitation is invalid, expired, or was sent to a different address. You are signed in as {email}. Only a verified account with the
              invited email can accept it.
            </CardDescription>
          </CardHeader>
          {home}
        </>
      ) : state.kind === 'declined' ? (
        <>
          <CardHeader>
            <CardTitle>Invitation declined</CardTitle>
          </CardHeader>
          {home}
        </>
      ) : (
        <>
          <CardHeader>
            <CardTitle>Join {state.invitation.organizationName}</CardTitle>
            <CardDescription>
              You were invited as {state.invitation.role}. Expires {formatDate(state.invitation.expiresAt)}.
            </CardDescription>
          </CardHeader>
          {error ? (
            <CardContent>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </CardContent>
          ) : null}
          <CardFooter className="gap-2">
            <Button disabled={busy} onClick={() => act('accept')}>
              Accept invitation
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => act('decline')}>
              Decline
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  );
}
