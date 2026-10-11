/**
 * Dashboard control-plane client: fetch wrapper for backend /v1 routes over
 * the browser session cookie (credentials included, no bearer tokens).
 * Throws {status, code, message} on error envelopes. Raw secrets appear only
 * in their creating responses and are never logged or persisted here.
 */
export interface ApiError extends Error {
  status: number;
  code: string;
}

interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export type Runtime = 'microvm' | 'gvisor';

export interface Dock {
  id: string;
  workspaceId: string;
  name: string;
  image?: string;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
  runtime: Runtime;
  /** Paths that survive a stop: ["/"] on microvm, ["/home/user/work"] on gvisor. */
  persistentPaths: string[];
  state: string;
  ttlSeconds?: number | null;
  environment?: string;
  ip?: string | null;
  hostId?: string | null;
  billingPausedAt?: string | null;
  setupStatus?: string | null;
  setupError?: string | null;
  lastSnapshotAt?: string | null;
  stateChangedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Bounded result of one command run in a dock (`POST /v1/docks/:id/exec`). */
export interface DockExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

/** Single-use, 30s credential for the dock terminal WebSocket (`POST /v1/docks/:id/terminal`). */
export interface DockTerminalTicket {
  ticket: string;
  expiresAt: string;
}

/** Host-truth usage counters; network bytes are cumulative since boot. */
export interface DockStatsMetrics {
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  diskBytes: number;
  rxBytes: number;
  txBytes: number;
}

/** `GET /v1/docks/:id/stats`: latest sample (null before the first poll) plus the window aggregate. */
export interface DockStats {
  dockId: string;
  state: string;
  sample: (DockStatsMetrics & { at: string; source: string }) | null;
  window?: { window: string; samples: number; avg: DockStatsMetrics; peak: DockStatsMetrics };
}

export interface GithubRun {
  id: string;
  installationId: string;
  workspaceId: string;
  organizationId?: string | null;
  repo: string;
  issueNumber: number;
  dockId?: string | null;
  state: string;
  prNumber?: number | null;
  prUrl?: string | null;
  failureReason?: string | null;
  agent?: string;
  branch?: string | null;
  baseBranch?: string;
  promptVersion?: string | null;
  testCommand?: string | null;
  completionStatus?: string | null;
  events?: Array<{ t: string; at: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export type ConnectorCredentialType = 'oauth' | 'personal_token' | 'bot_token' | 'org_token' | 'user_token' | 'token';

export interface Connector {
  kind: string;
  type: 'tool' | 'github' | 'model-keys';
  status: 'connected' | 'not_connected' | 'reauth_required';
  accountLabel: string | null;
  /** How the connection authenticated; null when not connected or not a tool. */
  credentialType: ConnectorCredentialType | null;
  scopes: string[];
  oauthAvailable: boolean;
  readOnly: boolean;
  updatedAt: string | null;
}

/** A Dockyard catalog image (`GET /v1/images`); `available` is false when no host serves it. */
export interface DockImage {
  name: string;
  description: string;
  arch: string[];
  sizeMiB: number;
  contents: string;
  available: boolean;
}

export interface Snapshot {
  id: string;
  dockId?: string;
  status?: string;
  sizeBytes?: number;
  createdAt?: string;
}

export interface SnapshotFile {
  path: string;
  size: number;
}

export interface Template {
  name: string;
  organizationId: string;
  status?: string;
  sizeBytes?: number;
  sourceDockId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EnvironmentRepo {
  id: string;
  provider: 'github' | 'gitlab';
  repositoryId: string;
  fullName: string;
  baseBranch: string | null;
  hasSetupScript: boolean;
}

export interface Environment {
  id: string;
  name: string;
  organizationId: string;
  isDefault: boolean;
  currentVersion: number;
  secretsAccess: 'members' | 'admins';
  safeForThirdParties: boolean;
  passGithub: boolean;
  passSecrets: boolean;
  passAgentsCredentials: boolean;
  passDockCredentials: boolean;
  /** HTTPS hosts docks may reach; null leaves outbound open. */
  egressAllow: string[] | null;
  /** github: the org has a GitHub App installation that can clone private repos. */
  connections: Record<'github' | 'gitlab', { connected: boolean }>;
  varNames: string[];
  files: { path: string; size: number }[];
  repos: EnvironmentRepo[];
  updatedAt: string;
  createdAt: string;
}

export interface EnvironmentVersion {
  version: number;
  createdAt: string;
  dockCount: number;
}

export interface RevealedSecrets {
  envContents: string;
  secretFiles: { path: string; size: number; contents: string }[];
}

/** Pending member invitation as org admins see it. */
export interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

/** Invitation addressed to the signed-in user. */
export interface MyInvitation {
  id: string;
  organizationName: string;
  role: string;
  expiresAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug?: string;
  role?: string;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  slug?: string;
  createdAt?: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  dockId: string | null;
  linkPath: string;
  read: boolean;
  occurredAt: string;
}

export interface InboxPage {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface NotificationPreference {
  type: string;
  audience: 'billing' | 'dock';
  enabled: boolean;
  emailEnabled: boolean;
}

interface SnapshotPage {
  snapshots?: Snapshot[];
  nextCursor?: string | null;
}

function asSnapshotList(data: Snapshot[] | SnapshotPage): Snapshot[] {
  return Array.isArray(data) ? data : (data.snapshots ?? []);
}

function apiError(status: number, code: string, message: string): ApiError {
  return Object.assign(new Error(message), { status, code });
}

/** Public, non-secret facts about this control plane (`GET /v1/config`). */
export interface InstanceConfig {
  apiUrl: string;
  appUrl: string;
  billingEnabled: boolean;
  authProviders: ('google' | 'github')[];
  mailDelivery: 'smtp' | 'log';
  githubAppConfigured: boolean;
  /** Where `ssh` connects; null when this instance has no SSH gateway. */
  ssh: { host: string; port: number } | null;
  /** Parent domain of exposed port URLs; null when hosted ports are off. */
  ports: { domain: string } | null;
  /** Members may connect their own ChatGPT subscription for runs they trigger. */
  chatgptSignIn: boolean;
}

/** The caller's own ChatGPT sign-in; tokens never leave the backend. */
export interface ChatgptConnection {
  connected: boolean;
  status: 'active' | 'expired' | null;
  email: string | null;
  planType: string | null;
  updatedAt: string | null;
}

export interface ChatgptDeviceCode {
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type ChatgptDevicePoll = { state: 'pending' } | ({ state: 'connected' } & ChatgptConnection);

export type PortVisibility = 'public' | 'private';

export interface DockPort {
  port: number;
  /** Private ports need an org member's sign-in or a dock-bound key. */
  visibility: PortVisibility;
  /** Null while hosted ports are off on this instance. */
  url: string | null;
  createdAt: string;
}

export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Either the linked installation, or the installations to pick from when GitHub sent none. */
export interface GithubInstallResult {
  installationId?: number;
  candidates?: Array<{ installationId: number; account: string }>;
}

export interface GithubAppManifestStart {
  postUrl: string;
  manifest: string;
  state: string;
}

export interface GithubAppCredentials {
  appId: number;
  slug: string;
  name: string;
  owner: string | null;
  htmlUrl: string;
  installUrl: string;
  envFile: string;
}

export interface Me {
  id: string;
  email: string;
  emailVerified: boolean;
  providers: string[];
  instanceAdmin: boolean;
}

/** `GET /v1/hosts` (instance admins only): one host and its last heartbeat. */
export interface HostSummary {
  id: string;
  address: string;
  cpuFamily: string;
  kernel: string;
  runtime: Runtime;
  kernelRelease: string | null;
  vcpuTotal: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  maxDocks: number;
  usedDocks: number;
  runningDocks: number;
  state: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

/** One runtime from a host's last heartbeat. */
export interface HostWorkload {
  dockId: string;
  state: string;
  kind?: string;
}

/** `GET /v1/hosts/:id`: the host plus everything placed on it, across organizations. */
export interface HostDetail extends HostSummary {
  docks: {
    id: string;
    name: string;
    state: string;
    cpus: number;
    memoryMiB: number;
    diskGiB: number;
    runtime: Runtime;
    ip: string | null;
    stateChangedAt: string;
    workspaceName: string;
    organizationId: string;
    organizationName: string;
  }[];
  runs: HostWorkload[];
  orphans: HostWorkload[];
}

/** Control-plane client contract owned by this module. */
export interface DockApi {
  getInstanceConfig: () => Promise<InstanceConfig>;
  getMe: () => Promise<Me>;
  listHosts: () => Promise<HostSummary[]>;
  getHost: (id: string) => Promise<HostDetail>;
  startGithubAppSetup: (organization?: string) => Promise<GithubAppManifestStart>;
  convertGithubAppSetup: (code: string, state: string) => Promise<GithubAppCredentials>;
  listDocks: (filter?: string, all?: boolean) => Promise<Dock[]>;
  getDock: (id: string) => Promise<Dock>;
  createDock: (input: Record<string, unknown>) => Promise<Dock>;
  listImages: () => Promise<DockImage[]>;
  listConnectors: (workspaceId: string) => Promise<Connector[]>;
  connectConnector: (workspaceId: string, kind: string, token: string) => Promise<Connector>;
  disconnectConnector: (workspaceId: string, kind: string) => Promise<unknown>;
  startConnectorOauth: (workspaceId: string, kind: string) => Promise<{ url: string }>;
  updateDock: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  deleteDock: (id: string) => Promise<unknown>;
  stopDock: (id: string, force?: boolean) => Promise<unknown>;
  resumeDock: (id: string, input?: Record<string, unknown>) => Promise<unknown>;
  branchDock: (id: string, input?: Record<string, unknown>) => Promise<unknown>;
  dockStats: (id: string, window?: string) => Promise<DockStats>;
  execDock: (id: string, input: { command: string; timeoutSeconds?: number; cwd?: string }) => Promise<DockExecResult>;
  createTerminalTicket: (id: string) => Promise<DockTerminalTicket>;
  listRuns: (workspaceId: string, state?: string) => Promise<GithubRun[]>;
  getRun: (id: string) => Promise<GithubRun>;
  listInstallations: (workspaceId: string) => Promise<unknown[]>;
  startGithubInstall: (workspaceId: string, mode?: 'install' | 'authorize') => Promise<{ url: string; state: string }>;
  completeGithubInstall: (input: { installationId?: number; code?: string; state?: string }) => Promise<GithubInstallResult>;
  updateInstallation: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  removeInstallation: (id: string) => Promise<unknown>;
  listSnapshots: (cursor?: string, limit?: number) => Promise<Snapshot[]>;
  listDockSnapshots: (dockId: string) => Promise<Snapshot[]>;
  latestSnapshot: (dockId: string) => Promise<Snapshot>;
  deleteSnapshot: (id: string) => Promise<unknown>;
  snapshotTree: (id: string) => Promise<{ snapshotId: string; files: SnapshotFile[] }>;
  listTemplates: () => Promise<Template[]>;
  getTemplate: (name: string, organizationId: string) => Promise<Template>;
  saveTemplate: (dockId: string, name: string) => Promise<Template>;
  deleteTemplate: (name: string, organizationId: string) => Promise<unknown>;
  listEnvironments: (organizationId: string) => Promise<Environment[]>;
  createEnvironment: (organizationId: string, name: string, secretsAccess?: 'members' | 'admins') => Promise<unknown>;
  getEnvironment: (ref: string, organizationId: string) => Promise<Environment>;
  updateEnvironment: (ref: string, organizationId: string, input: Record<string, unknown>) => Promise<unknown>;
  deleteEnvironment: (ref: string, organizationId: string) => Promise<unknown>;
  listEnvironmentVersions: (ref: string, organizationId: string) => Promise<EnvironmentVersion[]>;
  upgradeEnvironment: (ref: string, organizationId: string) => Promise<unknown>;
  addRepo: (ref: string, organizationId: string, input: Record<string, unknown>) => Promise<unknown>;
  removeRepo: (ref: string, repoId: string, organizationId: string) => Promise<unknown>;
  revealSecrets: (ref: string, organizationId: string) => Promise<RevealedSecrets>;
  setVar: (ref: string, organizationId: string, key: string, value: string) => Promise<unknown>;
  removeVar: (ref: string, key: string, organizationId: string) => Promise<unknown>;
  setFile: (ref: string, organizationId: string, input: Record<string, unknown>) => Promise<unknown>;
  removeFile: (ref: string, path: string, organizationId: string) => Promise<unknown>;
  listPlans: () => Promise<unknown[]>;
  getSubscription: (organizationId: string) => Promise<unknown>;
  changePlan: (organizationId: string, plan: string) => Promise<unknown>;
  cancelSubscription: (organizationId: string) => Promise<unknown>;
  getUsage: (organizationId: string) => Promise<unknown>;
  getBudget: (organizationId: string) => Promise<unknown>;
  putBudget: (organizationId: string, amountCents: number | null) => Promise<unknown>;
  listInvoices: (organizationId: string) => Promise<unknown[]>;
  getInvoice: (id: string, organizationId: string) => Promise<unknown>;
  listWebhookEndpoints: (organizationId: string) => Promise<unknown[]>;
  createWebhookEndpoint: (input: Record<string, unknown>) => Promise<unknown>;
  getWebhookEndpoint: (id: string, organizationId: string) => Promise<unknown>;
  removeWebhookEndpoint: (id: string, organizationId: string) => Promise<unknown>;
  listWebhookDeliveries: (id: string, organizationId: string) => Promise<unknown[]>;
  listApiKeys: () => Promise<unknown[]>;
  createApiKey: (name: string, expiresAt?: string) => Promise<{ id: string; apiKey: string }>;
  revokeApiKey: (id: string) => Promise<unknown>;
  listDockPorts: (id: string) => Promise<DockPort[]>;
  exposeDockPort: (id: string, port: number, visibility?: PortVisibility) => Promise<DockPort>;
  removeDockPort: (id: string, port: number) => Promise<unknown>;
  listSshKeys: () => Promise<SshKey[]>;
  addSshKey: (name: string, publicKey: string) => Promise<SshKey>;
  deleteSshKey: (id: string) => Promise<unknown>;
  listProviderKeys: (organizationId: string) => Promise<unknown[]>;
  setProviderKey: (organizationId: string, provider: string, key: string) => Promise<unknown>;
  revealProviderKey: (provider: string, organizationId: string) => Promise<unknown>;
  removeProviderKey: (provider: string, organizationId: string) => Promise<unknown>;
  getChatgptConnection: () => Promise<ChatgptConnection>;
  startChatgptDevice: () => Promise<ChatgptDeviceCode>;
  pollChatgptDevice: () => Promise<ChatgptDevicePoll>;
  removeChatgptConnection: () => Promise<unknown>;
  listInbox: (cursor?: string, limit?: number) => Promise<InboxPage>;
  markNotificationRead: (id: string) => Promise<unknown>;
  markAllNotificationsRead: () => Promise<{ updated: number }>;
  getNotificationPreferences: (organizationId: string) => Promise<NotificationPreference[]>;
  updateOrgNotificationPreference: (organizationId: string, type: string, enabled: boolean) => Promise<unknown>;
  updatePersonalNotificationPreference: (type: string, emailEnabled: boolean) => Promise<unknown>;
  listOrganizations: () => Promise<Organization[]>;
  getOrganization: (id: string) => Promise<Organization>;
  listMembers: (id: string) => Promise<unknown[]>;
  addMember: (id: string, input: Record<string, unknown>) => Promise<unknown>;
  updateMemberRole: (id: string, userId: string, role: string) => Promise<unknown>;
  removeMember: (id: string, userId: string) => Promise<unknown>;
  listInvitations: (id: string) => Promise<Invitation[]>;
  revokeInvitation: (id: string, invitationId: string) => Promise<unknown>;
  resendInvitation: (id: string, invitationId: string) => Promise<Invitation>;
  listMyInvitations: () => Promise<MyInvitation[]>;
  getInvitation: (token: string) => Promise<MyInvitation>;
  acceptInvitation: (token: string) => Promise<{ organizationId: string; role: string }>;
  declineInvitation: (token: string) => Promise<unknown>;
  acceptMyInvitation: (id: string) => Promise<{ organizationId: string; role: string }>;
  declineMyInvitation: (id: string) => Promise<unknown>;
  listWorkspaces: (orgId: string) => Promise<Workspace[]>;
  createWorkspace: (orgId: string, input: Record<string, unknown>) => Promise<Workspace>;
  updateWorkspace: (id: string, input: { name?: string; slug?: string }) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<unknown>;
  getProfile: () => Promise<unknown>;
  updateProfile: (input: Record<string, unknown>) => Promise<unknown>;
  listConnections: () => Promise<{ connections: unknown[] }>;
  removeConnection: (id: string) => Promise<unknown>;
  getRetention: (organizationId: string) => Promise<unknown>;
  updateRetention: (organizationId: string, enabled: boolean, confirmation: string) => Promise<unknown>;
  getOperation: (id: string) => Promise<unknown>;
  closeAccount: () => Promise<unknown>;
  reopenAccount: () => Promise<unknown>;
  eraseAccount: (confirmation: string) => Promise<unknown>;
}

export function createDockApi({ baseUrl = '', fetchImpl = fetch, headers = {} }: ClientOptions = {}): DockApi {
  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await fetchImpl(baseUrl + path, {
      method,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      data?: T;
      code?: string;
      message?: string;
    };
    if (!res.ok || json.ok === false) {
      throw apiError(res.status, json.code ?? 'unknown', json.message ?? 'Request failed');
    }
    return (json.data ?? json) as T;
  }

  const enc = encodeURIComponent;
  const get = <T>(path: string) => call<T>('GET', path);
  const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body);
  const patch = <T>(path: string, body?: unknown) => call<T>('PATCH', path, body);
  const put = <T>(path: string, body?: unknown) => call<T>('PUT', path, body);
  const del = <T>(path: string) => call<T>('DELETE', path);
  // Destructive deletes echo the resource id as an explicit confirmation.
  const delConfirmed = <T>(path: string, id: string) => call<T>('DELETE', path, undefined, { 'x-confirm-delete': id });

  return {
    getInstanceConfig: () => get<InstanceConfig>('/v1/config'),
    startGithubAppSetup: (organization?: string) =>
      post<GithubAppManifestStart>('/v1/github/app-setup/start', organization ? { organization } : {}),
    convertGithubAppSetup: (code: string, state: string) =>
      post<GithubAppCredentials>('/v1/github/app-setup/conversion', { code, state }),

    // Docks: lifecycle is async; mutating calls return operations to poll.
    listDocks: (filter?: string, all?: boolean) => {
      const q = new URLSearchParams();
      if (filter) q.set('filter', filter);
      if (all) q.set('all', 'true');
      const s = q.toString();
      return get<Dock[]>(`/v1/docks${s ? `?${s}` : ''}`);
    },
    getDock: (id: string) => get<Dock>(`/v1/docks/${enc(id)}`),
    createDock: (input: Record<string, unknown>) => post<Dock>('/v1/docks', input),
    listImages: () => get<DockImage[]>('/v1/images'),
    listConnectors: (workspaceId: string) => get<Connector[]>(`/v1/workspaces/${enc(workspaceId)}/connectors`),
    connectConnector: (workspaceId: string, kind: string, token: string) =>
      put<Connector>(`/v1/workspaces/${enc(workspaceId)}/connectors/${enc(kind)}`, { token }),
    disconnectConnector: (workspaceId: string, kind: string) =>
      del<unknown>(`/v1/workspaces/${enc(workspaceId)}/connectors/${enc(kind)}`),
    startConnectorOauth: (workspaceId: string, kind: string) =>
      get<{ url: string }>(`/v1/connectors/${enc(kind)}/oauth/start?workspaceId=${enc(workspaceId)}`),
    updateDock: (id: string, input: Record<string, unknown>) => patch<unknown>(`/v1/docks/${enc(id)}`, input),
    deleteDock: (id: string) => delConfirmed<unknown>(`/v1/docks/${enc(id)}`, id),
    stopDock: (id: string, force?: boolean) => post<unknown>(`/v1/docks/${enc(id)}/stop`, { force }),
    resumeDock: (id: string, input: Record<string, unknown> = {}) =>
      post<unknown>(`/v1/docks/${enc(id)}/resume`, input),
    branchDock: (id: string, input: Record<string, unknown> = {}) =>
      post<unknown>(`/v1/docks/${enc(id)}/branch`, input),
    dockStats: (id: string, window?: string) =>
      get<DockStats>(`/v1/docks/${enc(id)}/stats${window ? `?window=${enc(window)}` : ''}`),
    execDock: (id: string, input: { command: string; timeoutSeconds?: number; cwd?: string }) =>
      post<DockExecResult>(`/v1/docks/${enc(id)}/exec`, input),
    createTerminalTicket: (id: string) => post<DockTerminalTicket>(`/v1/docks/${enc(id)}/terminal`),

    // Runs: one list query with optional state; detail carries the timeline.
    listRuns: (workspaceId: string, state?: string) => {
      const q = new URLSearchParams({ workspaceId });
      if (state) q.set('state', state);
      return get<GithubRun[]>(`/v1/github/runs?${q.toString()}`);
    },
    getRun: (id: string) => get<GithubRun>(`/v1/github/runs/${enc(id)}`),
    listInstallations: (workspaceId: string) =>
      get<unknown[]>(`/v1/github/installations?workspaceId=${enc(workspaceId)}`),
    startGithubInstall: (workspaceId: string, mode?: 'install' | 'authorize') =>
      post<{ url: string; state: string }>('/v1/github/installations/start', mode ? { workspaceId, mode } : { workspaceId }),
    completeGithubInstall: (input: { installationId?: number; code?: string; state?: string }) =>
      post<GithubInstallResult>('/v1/github/installations/complete', input),
    updateInstallation: (id: string, input: Record<string, unknown>) =>
      patch<unknown>(`/v1/github/installations/${enc(id)}`, input),
    removeInstallation: (id: string) => del<unknown>(`/v1/github/installations/${enc(id)}`),

    // Snapshots stream from captures; templates are frozen named states.
    listSnapshots: async (cursor?: string, limit?: number) => {
      const q = new URLSearchParams();
      if (cursor) q.set('cursor', cursor);
      if (limit) q.set('limit', String(limit));
      const s = q.toString();
      const page = await get<Snapshot[] | SnapshotPage>(`/v1/snapshots${s ? `?${s}` : ''}`);
      return asSnapshotList(page);
    },
    listDockSnapshots: async (dockId: string) => {
      const page = await get<Snapshot[] | SnapshotPage>(`/v1/docks/${enc(dockId)}/snapshots`);
      return asSnapshotList(page);
    },
    latestSnapshot: (dockId: string) => get<Snapshot>(`/v1/docks/${enc(dockId)}/snapshots/latest`),
    deleteSnapshot: (id: string) => delConfirmed<unknown>(`/v1/snapshots/${enc(id)}`, id),
    snapshotTree: (id: string) => get<{ snapshotId: string; files: SnapshotFile[] }>(`/v1/snapshots/${enc(id)}/tree`),
    listTemplates: () => get<Template[]>('/v1/templates'),
    getTemplate: (name: string, organizationId: string) => get<Template>(`/v1/templates/${enc(name)}?organizationId=${enc(organizationId)}`),
    saveTemplate: (dockId: string, name: string) => post<Template>('/v1/templates', { dockId, name }),
    deleteTemplate: (name: string, organizationId: string) => del<unknown>(`/v1/templates/${enc(name)}?organizationId=${enc(organizationId)}`),

    // Environments: versioned bundles with repos, vars, files, secrets.
    listEnvironments: (organizationId: string) =>
      get<Environment[]>(`/v1/environments?organizationId=${enc(organizationId)}`),
    createEnvironment: (organizationId: string, name: string, secretsAccess?: 'members' | 'admins') =>
      post<unknown>('/v1/environments', { organizationId, name, secretsAccess }),
    getEnvironment: (ref: string, organizationId: string) =>
      get<Environment>(`/v1/environments/${enc(ref)}?organizationId=${enc(organizationId)}`),
    updateEnvironment: (ref: string, organizationId: string, input: Record<string, unknown>) =>
      patch<unknown>(`/v1/environments/${enc(ref)}?organizationId=${enc(organizationId)}`, input),
    deleteEnvironment: (ref: string, organizationId: string) =>
      del<unknown>(`/v1/environments/${enc(ref)}?organizationId=${enc(organizationId)}`),
    listEnvironmentVersions: (ref: string, organizationId: string) =>
      get<EnvironmentVersion[]>(`/v1/environments/${enc(ref)}/versions?organizationId=${enc(organizationId)}`),
    upgradeEnvironment: (ref: string, organizationId: string) =>
      post<unknown>(`/v1/environments/${enc(ref)}/upgrade?organizationId=${enc(organizationId)}`),
    addRepo: (ref: string, organizationId: string, input: Record<string, unknown>) =>
      post<unknown>(`/v1/environments/${enc(ref)}/repos?organizationId=${enc(organizationId)}`, input),
    removeRepo: (ref: string, repoId: string, organizationId: string) =>
      del<unknown>(`/v1/environments/${enc(ref)}/repos/${enc(repoId)}?organizationId=${enc(organizationId)}`),
    revealSecrets: (ref: string, organizationId: string) =>
      post<RevealedSecrets>(
        `/v1/environments/${enc(ref)}/secrets:reveal?organizationId=${enc(organizationId)}`,
      ),
    setVar: (ref: string, organizationId: string, key: string, value: string) =>
      post<unknown>(`/v1/environments/${enc(ref)}/vars?organizationId=${enc(organizationId)}`, { key, value }),
    removeVar: (ref: string, key: string, organizationId: string) =>
      del<unknown>(`/v1/environments/${enc(ref)}/vars/${enc(key)}?organizationId=${enc(organizationId)}`),
    setFile: (ref: string, organizationId: string, input: Record<string, unknown>) =>
      post<unknown>(`/v1/environments/${enc(ref)}/files?organizationId=${enc(organizationId)}`, input),
    removeFile: (ref: string, path: string, organizationId: string) =>
      del<unknown>(`/v1/environments/${enc(ref)}/files/${enc(path)}?organizationId=${enc(organizationId)}`),

    // Billing: reads are member-visible; money moves need the browser session.
    listPlans: () => get<unknown[]>('/v1/billing/plans'),
    getSubscription: (organizationId: string) =>
      get<unknown>(`/v1/billing/subscription?organizationId=${enc(organizationId)}`),
    changePlan: (organizationId: string, plan: string) =>
      post<unknown>('/v1/billing/subscription', { organizationId, plan }),
    cancelSubscription: (organizationId: string) =>
      post<unknown>('/v1/billing/subscription/cancel', { organizationId }),
    getUsage: (organizationId: string) => get<unknown>(`/v1/billing/usage?organizationId=${enc(organizationId)}`),
    getBudget: (organizationId: string) => get<unknown>(`/v1/billing/budget?organizationId=${enc(organizationId)}`),
    putBudget: (organizationId: string, amountCents: number | null) =>
      put<unknown>('/v1/billing/budget', { organizationId, amountCents }),
    listInvoices: (organizationId: string) =>
      get<unknown[]>(`/v1/billing/invoices?organizationId=${enc(organizationId)}`),
    getInvoice: (id: string, organizationId: string) =>
      get<unknown>(`/v1/billing/invoices/${enc(id)}?organizationId=${enc(organizationId)}`),

    // Webhooks: endpoint metadata never carries secrets; deliveries inspectable.
    listWebhookEndpoints: (organizationId: string) =>
      get<unknown[]>(`/v1/webhooks/endpoints?organizationId=${enc(organizationId)}`),
    createWebhookEndpoint: (input: Record<string, unknown>) => post<unknown>('/v1/webhooks/endpoints', input),
    getWebhookEndpoint: (id: string, organizationId: string) =>
      get<unknown>(`/v1/webhooks/endpoints/${enc(id)}?organizationId=${enc(organizationId)}`),
    removeWebhookEndpoint: (id: string, organizationId: string) =>
      del<unknown>(`/v1/webhooks/endpoints/${enc(id)}?organizationId=${enc(organizationId)}`),
    listWebhookDeliveries: (id: string, organizationId: string) =>
      get<unknown[]>(`/v1/webhooks/endpoints/${enc(id)}/deliveries?organizationId=${enc(organizationId)}`),

    // API keys: raw secret appears only in the create response.
    listApiKeys: () => get<unknown[]>('/v1/api-keys'),
    createApiKey: (name: string, expiresAt?: string) =>
      post<{ id: string; apiKey: string }>('/v1/api-keys', { name, expiresAt }),
    revokeApiKey: (id: string) => del<unknown>(`/v1/api-keys/${enc(id)}`),

    listDockPorts: (id: string) => get<DockPort[]>(`/v1/docks/${enc(id)}/ports`),
    exposeDockPort: (id: string, port: number, visibility?: PortVisibility) => post<DockPort>(`/v1/docks/${enc(id)}/ports`, { port, visibility }),
    removeDockPort: (id: string, port: number) => del<unknown>(`/v1/docks/${enc(id)}/ports/${port}`),

    listSshKeys: () => get<SshKey[]>('/v1/ssh-keys'),
    addSshKey: (name: string, publicKey: string) => post<SshKey>('/v1/ssh-keys', { name, publicKey }),
    deleteSshKey: (id: string) => del<unknown>(`/v1/ssh-keys/${enc(id)}`),

    // Provider keys: values appear only in set responses, never in reads.
    listProviderKeys: (organizationId: string) =>
      get<unknown[]>(`/v1/agent-credentials?organizationId=${enc(organizationId)}`),
    setProviderKey: (organizationId: string, provider: string, key: string) =>
      put<unknown>('/v1/agent-credentials', { organizationId, provider, key }),
    revealProviderKey: (provider: string, organizationId: string) =>
      get<unknown>(`/v1/agent-credentials/${enc(provider)}/reveal?organizationId=${enc(organizationId)}`),
    removeProviderKey: (provider: string, organizationId: string) =>
      del<unknown>(`/v1/agent-credentials/${enc(provider)}?organizationId=${enc(organizationId)}`),

    // Personal ChatGPT sign-in via device code; the dashboard polls until approved.
    getChatgptConnection: () => get<ChatgptConnection>('/v1/chatgpt/connection'),
    startChatgptDevice: () => post<ChatgptDeviceCode>('/v1/chatgpt/connection/device', {}),
    pollChatgptDevice: () => post<ChatgptDevicePoll>('/v1/chatgpt/connection/device/poll', {}),
    removeChatgptConnection: () => del<unknown>('/v1/chatgpt/connection'),

    // Notifications: personal inbox plus org and personal preferences.
    listInbox: (cursor?: string, limit?: number) => {
      const q = new URLSearchParams();
      if (cursor) q.set('cursor', cursor);
      if (limit) q.set('limit', String(limit));
      const s = q.toString();
      return get<InboxPage>(`/v1/notifications${s ? `?${s}` : ''}`);
    },
    markNotificationRead: (id: string) => post<unknown>(`/v1/notifications/${enc(id)}/read`),
    markAllNotificationsRead: () => post<{ updated: number }>('/v1/notifications/read-all'),
    getNotificationPreferences: async (organizationId: string) => {
      const page = await get<{ preferences: NotificationPreference[] }>(
        `/v1/notifications/preferences?organizationId=${enc(organizationId)}`,
      );
      return page.preferences;
    },
    updateOrgNotificationPreference: (organizationId: string, type: string, enabled: boolean) =>
      put<unknown>('/v1/notifications/preferences/organization', { organizationId, type, enabled }),
    updatePersonalNotificationPreference: (type: string, emailEnabled: boolean) =>
      put<unknown>('/v1/notifications/preferences/personal', { type, emailEnabled }),

    // Organizations, workspaces, identity.
    listOrganizations: () => get<Organization[]>('/v1/organizations'),
    getOrganization: (id: string) => get<Organization>(`/v1/organizations/${enc(id)}`),
    listMembers: (id: string) => get<unknown[]>(`/v1/organizations/${enc(id)}/members`),
    addMember: (id: string, input: Record<string, unknown>) =>
      post<unknown>(`/v1/organizations/${enc(id)}/members`, input),
    updateMemberRole: (id: string, userId: string, role: string) =>
      patch<unknown>(`/v1/organizations/${enc(id)}/members/${enc(userId)}`, { role }),
    removeMember: (id: string, userId: string) =>
      del<unknown>(`/v1/organizations/${enc(id)}/members/${enc(userId)}`),
    listInvitations: (id: string) => get<Invitation[]>(`/v1/organizations/${enc(id)}/invitations`),
    revokeInvitation: (id: string, invitationId: string) =>
      del<unknown>(`/v1/organizations/${enc(id)}/invitations/${enc(invitationId)}`),
    resendInvitation: (id: string, invitationId: string) =>
      post<Invitation>(`/v1/organizations/${enc(id)}/invitations/${enc(invitationId)}/resend`),
    listMyInvitations: () => get<MyInvitation[]>('/v1/me/invitations'),
    getInvitation: (token: string) => get<MyInvitation>(`/v1/invitations/${enc(token)}`),
    acceptInvitation: (token: string) =>
      post<{ organizationId: string; role: string }>(`/v1/invitations/${enc(token)}/accept`),
    declineInvitation: (token: string) => post<unknown>(`/v1/invitations/${enc(token)}/decline`),
    acceptMyInvitation: (id: string) =>
      post<{ organizationId: string; role: string }>(`/v1/me/invitations/${enc(id)}/accept`),
    declineMyInvitation: (id: string) => post<unknown>(`/v1/me/invitations/${enc(id)}/decline`),
    listWorkspaces: (orgId: string) => get<Workspace[]>(`/v1/organizations/${enc(orgId)}/workspaces`),
    createWorkspace: (orgId: string, input: Record<string, unknown>) =>
      post<Workspace>(`/v1/organizations/${enc(orgId)}/workspaces`, input),
    updateWorkspace: (id: string, input: { name?: string; slug?: string }) =>
      patch<Workspace>(`/v1/workspaces/${enc(id)}`, input),
    deleteWorkspace: (id: string) => del<unknown>(`/v1/workspaces/${enc(id)}`),
    getMe: () => get<Me>('/v1/me'),
    listHosts: () => get<HostSummary[]>('/v1/hosts'),
    getHost: (id: string) => get<HostDetail>(`/v1/hosts/${enc(id)}`),
    getProfile: () => get<unknown>('/v1/me/profile'),
    updateProfile: (input: Record<string, unknown>) => patch<unknown>('/v1/me/profile', input),
    listConnections: () => get<{ connections: unknown[] }>('/v1/me/connections'),
    removeConnection: (id: string) => del<unknown>(`/v1/me/connections/${enc(id)}`),

    // Safety: retention switch, operation polls, account closure.
    getRetention: (organizationId: string) =>
      get<unknown>(`/v1/account/retention?organizationId=${enc(organizationId)}`),
    updateRetention: (organizationId: string, enabled: boolean, confirmation: string) =>
      patch<unknown>(`/v1/account/retention?organizationId=${enc(organizationId)}`, { enabled, confirmation }),
    getOperation: (id: string) => get<unknown>(`/v1/operations/${enc(id)}`),
    closeAccount: () => post<unknown>('/v1/account/close'),
    reopenAccount: () => post<unknown>('/v1/account/reopen'),
    eraseAccount: (confirmation: string) => post<unknown>('/v1/account/erase', { confirmation }),
  };
}

/**
 * Browser-default client against the configured public backend origin (the
 * same host serving backend-hosted auth). Falls back to a local dev origin.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_BETTER_AUTH_BACKEND_URL ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000';

/** WebSocket URL for a dock terminal on the API origin; the ticket is the only credential. */
export function terminalSocketUrl(dockId: string, ticket: string, cols: number, rows: number): string {
  const url = new URL(`/v1/docks/${encodeURIComponent(dockId)}/terminal`, API_BASE_URL || window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({ ticket, cols: String(cols), rows: String(rows) }).toString();
  return url.toString();
}

// Origin for copyable snippets: the baked API base, else this instance's own origin.
export function apiSnippetBase(): string {
  return API_BASE_URL || (typeof window === 'undefined' ? '' : window.location.origin);
}

export function getDefaultApi(): DockApi {
  return createDockApi({ baseUrl: API_BASE_URL });
}
