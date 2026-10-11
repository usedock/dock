import { DockLocalProvider, LOCAL_SIZE } from './dock-local.ts';
import { DockProvider } from './dock.ts';
import { E2BProvider } from './e2b.ts';
import { ModalProvider } from './modal.ts';
import type { Provider } from './types.ts';
import { VercelProvider } from './vercel.ts';

type Env = Record<string, string | undefined>;

interface Entry {
  /** Env vars that must all be set for the adapter to run. */
  required: string[];
  build(env: Env): Provider;
}

const REGISTRY: Record<string, Entry> = {
  dock: {
    required: ['DOCK_API_URL', 'DOCK_API_KEY'],
    build: (env) =>
      new DockProvider({ apiUrl: env.DOCK_API_URL!, apiKey: env.DOCK_API_KEY!, workspaceId: env.DOCK_WORKSPACE_ID }),
  },
  // The local engine of the dock CLI; needs only the binary (DOCK_BIN, default `dock` on PATH).
  'dock-local': {
    required: [],
    build: (env) =>
      new DockLocalProvider({
        bin: env.DOCK_BIN || 'dock',
        size: { ...LOCAL_SIZE, memoryMiB: Number(env.DOCK_BENCH_MEMORY_MIB) || LOCAL_SIZE.memoryMiB },
      }),
  },
  e2b: { required: ['E2B_API_KEY'], build: (env) => new E2BProvider(env.E2B_API_KEY!) },
  modal: {
    required: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    build: (env) => new ModalProvider({ tokenId: env.MODAL_TOKEN_ID!, tokenSecret: env.MODAL_TOKEN_SECRET! }),
  },
  vercel: {
    required: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
    build: (env) =>
      new VercelProvider({ token: env.VERCEL_TOKEN!, teamId: env.VERCEL_TEAM_ID!, projectId: env.VERCEL_PROJECT_ID! }),
  },
};

export const PROVIDER_NAMES = Object.keys(REGISTRY);

export type ProviderChoice = { provider: Provider } | { skipped: string };

/** Builds the provider, or reports which env vars are missing so the run is skipped. */
export function selectProvider(name: string, env: Env = process.env): ProviderChoice {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`Unknown provider "${name}"; use ${PROVIDER_NAMES.join(', ')}`);
  const missing = entry.required.filter((k) => !env[k]);
  if (missing.length) return { skipped: `${name} skipped: set ${missing.join(', ')}` };
  return { provider: entry.build(env) };
}
