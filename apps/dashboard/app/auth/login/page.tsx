import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getDashboardSession } from '@/lib/session';
import { safeNext, withNext } from '@/lib/redirect';
import { signInProviders } from '@/lib/instance';
import { Logo } from '@/components/logo';
import { LoginForm } from '@/components/auth/login-form';
import { SocialButtons } from '@/components/auth/social-buttons';
import { Separator } from '@/components/ui/separator';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = safeNext((await searchParams).next);
  const session = await getDashboardSession();
  if (session) redirect(next);

  const providers = await signInProviders();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo className="text-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Dock</h1>
      </div>
      {providers.length > 0 ? (
        <>
          <SocialButtons providers={providers} next={next} />
          <div className="flex items-center gap-3">
            <Separator className="flex-1 shrink" />
            <span className="text-xs text-muted-foreground">or</span>
            <Separator className="flex-1 shrink" />
          </div>
        </>
      ) : null}
      <LoginForm next={next} />
      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link
          href={withNext('/auth/signup', next)}
          className="font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}
