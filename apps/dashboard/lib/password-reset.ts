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
