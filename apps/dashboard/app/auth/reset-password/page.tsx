import Link from 'next/link';
import { Logo } from '@/components/logo';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { readResetParams } from '@/lib/password-reset';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const { token, failed } = readResetParams(await searchParams);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo className="text-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      </div>
      {failed || !token ? (
        <p role="alert" className="text-center text-sm text-muted-foreground">
          This reset link is invalid or has expired.{' '}
          <Link
            href="/auth/forgot-password"
            className="font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Request a new link
          </Link>
        </p>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </div>
  );
}
