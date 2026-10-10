import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { AuthEntrance } from '@/components/auth/auth-entrance';

// Centered auth shell. The form column caps at ~400px on every viewport.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-1 bg-background text-foreground">
      <div className="flex w-full flex-col px-6 py-6 sm:px-10">
        <Link
          href="/"
          aria-label="Back"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-12">
          <AuthEntrance>{children}</AuthEntrance>
        </div>
      </div>
    </div>
  );
}
