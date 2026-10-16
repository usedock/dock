'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { authClient } from '@/lib/auth-client';
import { requestResetErrorMessage, resetPasswordRedirectTo } from '@/lib/password-reset';

// Same confirmation whether or not the email exists; the backend answers 200 for both.
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setPending(true);
    try {
      const { error } = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: resetPasswordRedirectTo(window.location.origin),
      });
      if (error) {
        setError(requestResetErrorMessage(error.status));
        return;
      }
      setSent(true);
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <Alert role="status">
        <AlertDescription>
          If an account exists for that email, we sent a reset link. On a self-hosted instance without email, the link
          is in the backend log.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          id="forgot-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? 'forgot-error' : undefined}
          className="h-10"
        />
      </div>
      {error && (
        <p id="forgot-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
