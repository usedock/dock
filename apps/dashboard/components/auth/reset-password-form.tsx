'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { PasswordInput } from '@/components/auth/password-input';
import { PasswordStrength } from '@/components/auth/password-strength';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isInvalidTokenError,
  newPasswordProblem,
} from '@/lib/password-reset';

// Sets a new password from the emailed token, then returns to sign-in.
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [apiFailed, setApiFailed] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setApiFailed(false);
    const problem = newPasswordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    try {
      const { error } = await authClient.resetPassword({ newPassword: password, token });
      if (error) {
        setError(error.message ?? 'Could not reset your password.');
        setApiFailed(isInvalidTokenError(error));
        setPending(false);
        return;
      }
      // Stay pending through navigation so a second click cannot resend the used token.
      router.push('/auth/login?reset=1');
    } catch {
      setError('Could not reach the server. Try again.');
      setPending(false);
    }
  };

  const describedBy = ['reset-password-strength', error ? 'reset-error' : null].filter(Boolean).join(' ') || undefined;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reset-password">New password</Label>
        <PasswordInput
          id="reset-password"
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          maxLength={MAX_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={describedBy}
          className="h-10"
        />
        <PasswordStrength password={password} id="reset-password-strength" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reset-confirm">Confirm password</Label>
        <PasswordInput
          id="reset-confirm"
          autoComplete="new-password"
          placeholder="Repeat the password"
          maxLength={MAX_PASSWORD_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={describedBy}
          className="h-10"
        />
      </div>
      {error && (
        <p id="reset-error" role="alert" className="text-xs text-destructive">
          {error}
          {apiFailed && (
            <>
              {' '}
              <Link href="/auth/forgot-password" className="underline underline-offset-4">
                Request a new link
              </Link>
            </>
          )}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? 'Saving…' : 'Reset password'}
      </Button>
    </form>
  );
}
