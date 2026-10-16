/** Copy and gating rules for the actionable empty states; kept pure so they are testable. */

export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.usedock.io';

type Coded = { code?: unknown } | null | undefined;

/** Instance-admin endpoints refuse an unverified email with this code. */
export function isEmailVerificationRequired(e: unknown): boolean {
  return (e as Coded)?.code === 'email_verification_required';
}

/** Closed accounts get this code on every route except reopen and erase. */
export function isAccountClosed(e: unknown): boolean {
  return (e as Coded)?.code === 'account_closed';
}

export type AccountAction = 'close' | 'reopen' | 'erase';

/** Close only applies to an open account, reopen only to a closed one. */
export function visibleAccountActions(closed: boolean): AccountAction[] {
  return closed ? ['reopen', 'erase'] : ['close', 'erase'];
}

export function runsEmptyHint(githubLinked: boolean | null): { text: string; href?: string; linkText?: string } {
  if (githubLinked === false) {
    return { text: 'No GitHub App is linked to this workspace.', href: '/developers/github', linkText: 'Set up the GitHub App' };
  }
  return { text: 'Mention @dock on a GitHub issue to start the first run.' };
}

/** Enrollment command from the self-hosting docs, pointed at this instance's public URL. */
export function hostEnrollLines(fleetUrl: string): string[] {
  return [
    '# On the control plane machine (deploy/self-host), print the fleet token:',
    'grep ^FLEET_TOKEN= .env',
    '# On the new Linux machine, from a usedock/docklet checkout:',
    'read -rs DOCKLET_FLEET_TOKEN && export DOCKLET_FLEET_TOKEN',
    'sudo --preserve-env=DOCKLET_FLEET_TOKEN bash scripts/bootstrap-host.sh \\',
    `  --fleet-url ${fleetUrl} \\`,
    '  --runtime microvm',
  ];
}

const HOSTED_API_URL = 'https://api.usedock.io';

/** A bare `dock login` targets the cloud context, so a self-hosted key first needs a context for this URL. */
export function cliLoginLines(apiUrl: string): string[] {
  const login = ['dock login', '# or, non-interactively:', 'echo "$DOCK_API_KEY" | dock login'];
  if (apiUrl.replace(/\/+$/, '') === HOSTED_API_URL) return login;
  let name = 'self-hosted';
  try {
    const host = new URL(apiUrl).hostname;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(host)) name = host;
  } catch {
    // Keep the fallback name when the URL does not parse.
  }
  return [`dock context add ${name} --url ${apiUrl}`, `dock context use ${name}`, ...login];
}

export function notificationsCopy(billingEnabled: boolean) {
  return {
    subtitle: billingEnabled ? 'Dock and billing alerts for you and your organizations.' : 'Dock alerts for you and your organizations.',
    emptyHint: billingEnabled
      ? 'Disk warnings, unresponsive docks, and billing alerts show up here.'
      : 'Disk warnings and unresponsive docks show up here.',
    stopRefusedDetail: billingEnabled
      ? 'The final snapshot failed, so the dock keeps running with billing paused.'
      : 'The final snapshot failed, so the dock keeps running.',
  };
}
