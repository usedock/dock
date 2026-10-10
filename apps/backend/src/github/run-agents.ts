/** One agent a run can execute and the provider keys it reads. Dock never installs agents: users bring their own via environment setup. */
export interface RunAgent {
  /** Provider env vars the agent can use; a run needs at least one. */
  requiredKeys: string[];
}

export const RUN_AGENTS: Record<string, RunAgent> = {
  opencode: { requiredKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY'] },
  codex: { requiredKeys: ['OPENAI_API_KEY'] },
};

/** Agents a dock receives provider credentials for when it is not a run. */
export const DEFAULT_DOCK_AGENTS: readonly string[] = ['opencode'];

export function runAgentNames(): string[] {
  return Object.keys(RUN_AGENTS);
}

/** Provider keys the named agents read, deduplicated; unknown names contribute none. */
export function requiredKeysFor(agents: readonly string[]): string[] {
  return [...new Set(agents.flatMap((agent) => RUN_AGENTS[agent]?.requiredKeys ?? []))];
}
