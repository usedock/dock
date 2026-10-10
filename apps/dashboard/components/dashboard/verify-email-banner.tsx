'use client';

import { useState } from 'react';
import { MailWarning } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { sendVerificationEmail } from '@/lib/auth-client';

/** Notice for unverified accounts with a button that sends a fresh verification link. */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function send() {
    setState('sending');
    const { error } = await sendVerificationEmail({ email, callbackURL: window.location.href });
    setState(error ? 'error' : 'sent');
  }

  return (
    <Alert>
      <MailWarning />
      <AlertTitle>Verify your email</AlertTitle>
      <AlertDescription>
        {state === 'sent'
          ? `Verification link sent to ${email}. On a self-hosted instance without SMTP it is in the backend log.`
          : state === 'error'
            ? 'Could not send the verification email. Try again.'
            : `${email} is not verified yet. Instance admin features need a verified email.`}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" disabled={state === 'sending' || state === 'sent'} onClick={send}>
          Send verification email
        </Button>
      </AlertAction>
    </Alert>
  );
}
