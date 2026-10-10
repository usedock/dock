'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.76 0 3.34.6 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76Z"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="size-4">
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.93c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.2.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export const SOCIAL_PROVIDERS = {
  google: { label: 'Google', Mark: GoogleMark },
  github: { label: 'GitHub', Mark: GitHubMark },
} as const;

export type SocialProvider = keyof typeof SOCIAL_PROVIDERS;

// OAuth entry points. The backend reports which providers have credentials;
// only those render, so secrets never reach the client.
export function SocialButtons({ providers, next = '/' }: { providers: SocialProvider[]; next?: string }) {
  const [pending, setPending] = useState<SocialProvider | null>(null);

  const start = async (provider: SocialProvider) => {
    setPending(provider);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: `${window.location.origin}${next}`,
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      {providers.map((provider) => {
        const { label, Mark } = SOCIAL_PROVIDERS[provider];
        return (
          <Button
            key={provider}
            type="button"
            variant="outline"
            size="lg"
            disabled={pending !== null}
            onClick={() => start(provider)}
            className="w-full"
          >
            <Mark />
            {pending === provider ? 'Redirecting…' : `Continue with ${label}`}
          </Button>
        );
      })}
    </div>
  );
}
