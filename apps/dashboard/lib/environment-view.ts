/** Pure view helpers for the environment page; kept separate so they are testable. */

export const ENV_TABS = ['repos', 'vars', 'settings', 'versions', 'secrets'] as const;
export type EnvTab = (typeof ENV_TABS)[number];

const TAB_ALIASES: Record<string, EnvTab> = {
  repositories: 'repos',
  repository: 'repos',
  variables: 'vars',
  files: 'vars',
  env: 'vars',
  reveal: 'secrets',
};

/** Maps a ?tab= value (or a friendly alias) to a tab; unknown values give the first tab. */
export function resolveEnvTab(value: string | null | undefined): EnvTab {
  const key = (value ?? '').toLowerCase();
  if ((ENV_TABS as readonly string[]).includes(key)) return key as EnvTab;
  return TAB_ALIASES[key] ?? ENV_TABS[0];
}

const PROVIDER_LABELS: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** Display name of a repository provider; the API value is unchanged. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** "1 dock" / "3 docks". */
export function dockCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'dock' : 'docks'}`;
}
