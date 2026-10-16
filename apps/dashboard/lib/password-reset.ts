/** Where the emailed link lands; must be an origin Better Auth trusts (the dashboard's). */
export function resetPasswordRedirectTo(origin: string): string {
  return `${origin}/auth/reset-password`;
}

type Param = string | string[] | undefined;

/** Token or error from the reset redirect; an error always wins over a token. */
export function readResetParams(params: { token?: Param; error?: Param }): { token: string | null; failed: boolean } {
  const first = (v: Param) => (Array.isArray(v) ? v[0] : v) || null;
  const token = first(params.token);
  return { token, failed: first(params.error) !== null || token === null };
}

/** Message for a failed reset request; these fail before the account lookup, so they say nothing about the email. */
export function requestResetErrorMessage(status: number): string {
  return status === 429 ? 'Too many requests. Wait a minute and try again.' : 'Could not send a reset link. Try again.';
}
