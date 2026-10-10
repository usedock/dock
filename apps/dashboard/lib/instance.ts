import type { InstanceConfig } from './dock-api';
import type { SocialProvider } from '@/components/auth/social-buttons';

/** Server-side `GET /v1/config`; null when the backend is unreachable. */
export async function getInstanceConfig(): Promise<InstanceConfig | null> {
  const baseURL = process.env.BETTER_AUTH_BACKEND_URL;
  if (!baseURL) return null;
  try {
    const res = await fetch(`${baseURL}/v1/config`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: InstanceConfig };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/** Providers the backend has credentials for; falls back to the build-time flags when it is unreachable. */
export async function signInProviders(): Promise<SocialProvider[]> {
  const instance = await getInstanceConfig();
  if (instance) return instance.authProviders;
  const flags: [SocialProvider, string | undefined][] = [
    ['google', process.env.NEXT_PUBLIC_GOOGLE_ENABLED],
    ['github', process.env.NEXT_PUBLIC_GITHUB_ENABLED],
  ];
  return flags.filter(([, flag]) => flag !== 'false').map(([provider]) => provider);
}
