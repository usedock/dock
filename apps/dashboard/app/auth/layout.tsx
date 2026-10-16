import { AuthEntrance } from '@/components/auth/auth-entrance';

// Centered auth shell. The form column caps at ~400px on every viewport.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-1 bg-background text-foreground">
      <div className="flex w-full flex-col px-6 py-6 sm:px-10">
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-12">
          <AuthEntrance>{children}</AuthEntrance>
        </div>
      </div>
    </div>
  );
}
