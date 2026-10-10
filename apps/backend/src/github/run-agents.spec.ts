import { DEFAULT_DOCK_AGENTS, RUN_AGENTS, requiredKeysFor, runAgentNames } from './run-agents';

describe('run agents', () => {
  it('lists the agents a run can execute with provider keys and no installer', () => {
    expect(runAgentNames()).toEqual(['opencode', 'codex']);
    for (const agent of Object.values(RUN_AGENTS)) {
      expect(Object.keys(agent)).toEqual(['requiredKeys']);
      expect(agent.requiredKeys.length).toBeGreaterThan(0);
    }
  });

  it('merges required keys without duplicates and skips unknown agents', () => {
    expect(requiredKeysFor(['codex', 'opencode', 'nope'])).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY']);
    expect(requiredKeysFor([])).toEqual([]);
  });

  it('gives docks the opencode agent by default', () => {
    expect(DEFAULT_DOCK_AGENTS).toEqual(['opencode']);
  });
});
