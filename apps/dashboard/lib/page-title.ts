const SUFFIX = 'Dock Dashboard';

// Most specific prefix first; a prefix also matches its sub-routes.
const TITLES: [prefix: string, title: string][] = [
  ['/docks', 'Docks'],
  ['/snapshots', 'Snapshots & Templates'],
  ['/environments', 'Environments'],
  ['/runs', 'Runs'],
  ['/connectors', 'Connectors'],
  ['/hosts', 'Hosts'],
  ['/notifications', 'Notifications'],
  ['/billing', 'Billing'],
  ['/developers/webhooks', 'Webhooks'],
  ['/developers/api-keys', 'API keys'],
  ['/developers/ssh-keys', 'SSH keys'],
  ['/developers/provider-keys', 'Provider keys'],
  ['/developers/github', 'GitHub App'],
  ['/developers', 'Developers'],
  ['/settings/profile', 'Profile'],
  ['/settings/organization', 'Organization'],
  ['/settings/workspaces', 'Workspaces'],
  ['/settings/connections', 'Connections'],
  ['/settings/safety', 'Safety'],
  ['/settings', 'Settings'],
  ['/auth/login', 'Sign in'],
  ['/auth/signup', 'Create account'],
];

/** Browser tab title for a dashboard pathname. */
export function pageTitle(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path.startsWith('/docks/')) return `Dock | ${SUFFIX}`;
  const hit = TITLES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return hit ? `${hit[1]} | ${SUFFIX}` : SUFFIX;
}
