import { headers } from 'next/headers';

/**
 * Current dashboard session, resolved against backend-hosted auth with a
 * direct server fetch. get-session answers 200 with a null body when
 * unauthenticated, so the body (not the status) decides.
 */
export async function getDashboardSession(): Promise<{
  session: { token: string };
  user: { email: string; name: string; emailVerified?: boolean };
} | null> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return null;
  const baseURL = process.env.BETTER_AUTH_BACKEND_URL;
  if (!baseURL) return null;
  const res = await fetch(`${baseURL}/api/auth/get-session`, {
    headers: { cookie },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    session?: { token: string };
    user?: { email: string; name: string; emailVerified?: boolean };
  } | null;
  if (!data?.session || !data?.user) return null;
  return { session: data.session, user: data.user };
}
