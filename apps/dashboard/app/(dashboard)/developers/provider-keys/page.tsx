'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getDefaultApi, type ChatgptConnection, type ChatgptDeviceCode } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { cn } from '@/lib/utils';
import { CopyButton } from '@/components/dashboard/copy-button';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** `runs` mirrors the backend's run agents per gateway provider. */
const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', runs: ['opencode'] },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', runs: ['opencode', 'codex'] },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', runs: [] },
  { id: 'opencode', label: 'OpenCode Zen / Go', envVar: 'OPENCODE_API_KEY', runs: ['opencode'] },
];

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'OMP',
  hermes: 'Hermes',
};

function agentList(names: string[]): string {
  return names.length ? names.map((n) => AGENT_LABELS[n] ?? n).join(', ') : 'none';
}

/** Which @dock run agents can use a credential. */
function UsedBy({ runs }: { runs: string[] }) {
  return (
    <span className="text-xs">
      <span className="text-muted-foreground">@dock runs: </span>
      {agentList(runs)}
    </span>
  );
}

interface ProviderStatus {
  provider: string;
  configured?: boolean;
  updatedAt?: string | null;
}

/** The caller's own ChatGPT subscription: device-code sign-in, used only for runs they trigger. */
function ChatgptSection() {
  const [api] = useState(getDefaultApi);
  const instance = useInstanceConfig();
  const enabled = instance?.chatgptSignIn === true;
  const [connection, setConnection] = useState<ChatgptConnection | null>(null);
  const [githubLinked, setGithubLinked] = useState<boolean | null>(null);
  const [device, setDevice] = useState<ChatgptDeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .getChatgptConnection()
      .then(setConnection)
      .catch((e: unknown) => setError(messageOf(e, 'Could not load the ChatGPT sign-in.')));
    api
      .listConnections()
      .then((r) => setGithubLinked((r.connections as { provider: string }[]).some((c) => c.provider === 'github')))
      .catch(() => setGithubLinked(null));
  }, [api]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  // One poll per interval until approved, failed, or the code expires.
  useEffect(() => {
    if (!device) return;
    let live = true;
    const timer = setInterval(() => {
      if (Date.now() > new Date(device.expiresAt).getTime()) {
        setDevice(null);
        setError('The code expired. Start again.');
        return;
      }
      api
        .pollChatgptDevice()
        .then((out) => {
          if (!live || out.state !== 'connected') return;
          setDevice(null);
          setConnection(out);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setDevice(null);
          setError(messageOf(e, 'Sign-in failed.'));
        });
    }, device.intervalSeconds * 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, device]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setDevice(await api.startChatgptDevice());
    } catch (e: unknown) {
      setError(messageOf(e, 'Could not start the ChatGPT sign-in.'));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.removeChatgptConnection();
      refresh();
    } catch (e: unknown) {
      setError(messageOf(e, 'Could not disconnect.'));
    } finally {
      setBusy(false);
    }
  }

  if (!instance) return null;
  const connected = enabled && !device && connection?.connected === true;
  const action = !enabled || device || connection === null ? null : connected ? (
    <div className="flex gap-2">
      {connection.status !== 'active' ? (
        <Button type="button" size="sm" disabled={busy} onClick={start}>
          Reconnect
        </Button>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={disconnect}>
        Disconnect
      </Button>
    </div>
  ) : (
    <Button type="button" size="sm" disabled={busy} onClick={start}>
      {busy ? 'Starting…' : 'Connect ChatGPT'}
    </Button>
  );
  const uses = [
    {
      label: '@dock runs',
      agents: ['opencode', 'codex'],
      detail:
        githubLinked === false ? (
          <>
            Mentions you make on GitHub.{' '}
            <Link href="/settings/connections" className="text-foreground underline underline-offset-4">
              Link GitHub
            </Link>{' '}
            first so Dock knows they are yours.
          </>
        ) : (
          'Mentions you make on GitHub, instead of the organization keys.'
        ),
    },
    { label: 'Docks', agents: ['codex', 'opencode'], detail: 'Docks you create, from their next start or resume.' },
  ];

  return (
    <section className="rounded-md border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">ChatGPT subscription</h2>
            <Badge variant="outline">Personal</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Use your ChatGPT Plus or Pro plan for Codex and OpenCode. Only your own runs and docks use it.
          </p>
        </div>
        {action}
      </div>

      {!enabled ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Off on this instance. An operator can turn it on with{' '}
          <span className="font-mono text-foreground">CHATGPT_SIGNIN_ENABLED=true</span>.
        </p>
      ) : (
        <div className="flex flex-col divide-y">
          {error ? (
            <div className="px-4 py-3">
              <ErrorNote message={error} />
            </div>
          ) : null}
          {device ? (
            <div className="flex flex-col gap-3 px-4 py-4">
              <p className="text-sm">
                Open{' '}
                <a href={device.verificationUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  {device.verificationUrl.replace(/^https:\/\//, '')}
                </a>
                , sign in to ChatGPT, and enter this code:
              </p>
              <div className="flex items-center gap-2">
                <span className="rounded-md border px-3 py-1.5 font-mono text-lg tracking-widest">{device.userCode}</span>
                <CopyButton value={device.userCode} label="Copy code" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">Waiting for approval…</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDevice(null)}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Code rejected? Turn on device code sign-in for Codex in ChatGPT Settings, Security.
              </p>
            </div>
          ) : connection === null ? (
            <div className="px-4 py-3">
              <LoadingRows rows={1} />
            </div>
          ) : connected ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <span className="font-medium">{connection.email ?? 'ChatGPT account'}</span>
              {connection.planType ? <span className="text-muted-foreground capitalize">{connection.planType}</span> : null}
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className={cn('size-1.5 rounded-full', connection.status === 'active' ? 'bg-primary' : 'bg-destructive')}
                  aria-hidden
                />
                {connection.status === 'active' ? 'Connected' : 'Expired, reconnect to keep using it'}
              </span>
              <span className="text-xs text-muted-foreground">since {formatDate(connection.updatedAt)}</span>
            </div>
          ) : null}

          <dl className="grid grid-cols-[8rem_1fr] text-sm">
            {uses.map((u) => (
              <div key={u.label} className="col-span-2 grid grid-cols-subgrid gap-x-4 border-b px-4 py-2.5 last:border-b-0">
                <dt className="text-muted-foreground">{u.label}</dt>
                <dd className="flex flex-col gap-0.5">
                  <span>{agentList(u.agents)}</span>
                  <span className="text-xs text-muted-foreground">{u.detail}</span>
                </dd>
              </div>
            ))}
          </dl>

          <Collapsible className="px-4 py-2.5">
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&[data-panel-open]>svg]:rotate-180">
              How your sign-in stays safe
              <ChevronDown className="size-3.5 transition-transform" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 flex max-w-2xl list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                <li>Your ChatGPT tokens stay encrypted on the control plane and never enter a dock or run.</li>
                <li>
                  Docks get a gateway token that only works while the dock runs. Anyone with access to the dock can use
                  your quota during that time.
                </li>
                <li>
                  In those docks Dock manages <span className="font-mono">CODEX_HOME</span> and OpenCode&apos;s logins;
                  unset them in a shell to use your own. Environments that withhold agent credentials never get it.
                </li>
                <li>It reuses OpenAI&apos;s Codex sign-in, which is unofficial and may stop working.</li>
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </section>
  );
}

/** Org provider keys for agents: set/remove here, values never in reads. */
export default function ProviderKeysPage() {
  const { selectedOrgId } = useOrg();
  const [api] = useState(getDefaultApi);
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // The scope gate in render covers the unselected case; no sync resets.
  const refresh = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .listProviderKeys(selectedOrgId)
      .then((rows) => {
        setStatuses(rows as ProviderStatus[]);
        setError(null);
      })
      .catch((e: unknown) => {
        setStatuses([]);
        setError(messageOf(e, 'Could not load provider keys.'));
      });
  }, [api, selectedOrgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const configured = useCallback(
    (provider: string) => statuses?.find((s) => s.provider === provider)?.configured ?? false,
    [statuses],
  );

  async function save(provider: string) {
    if (!selectedOrgId) return;
    const key = (inputs[provider] ?? '').trim();
    if (!key) {
      setActionError('Paste a key before saving.');
      return;
    }
    setPending((p) => ({ ...p, [provider]: true }));
    setActionError(null);
    try {
      // Set response may carry the value once; drop it immediately.
      await api.setProviderKey(selectedOrgId, provider, key);
      setInputs((prev) => ({ ...prev, [provider]: '' }));
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not save ${provider} key: ${messageOf(e, 'request failed')}`);
    } finally {
      setPending((p) => ({ ...p, [provider]: false }));
    }
  }

  async function remove(provider: string) {
    if (!selectedOrgId) return;
    setPending((p) => ({ ...p, [provider]: true }));
    setActionError(null);
    try {
      await api.removeProviderKey(provider, selectedOrgId);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not remove ${provider} key: ${messageOf(e, 'request failed')}`);
    } finally {
      setPending((p) => ({ ...p, [provider]: false }));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Provider keys"
        description="Organization keys for coding agents in docks and @dock runs. Values never appear in reads."
      />
      {actionError ? <ErrorNote message={actionError} /> : null}
      {!selectedOrgId ? (
        <EmptyNote title="Pick an organization." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : statuses === null ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Set / rotate</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {PROVIDERS.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {p.label}
                    <div className="font-mono text-xs font-normal text-muted-foreground">{p.envVar}</div>
                  </TableCell>
                  <TableCell>
                    <UsedBy runs={p.runs} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={configured(p.id) ? 'default' : 'secondary'}>
                      {configured(p.id) ? 'configured' : 'not set'}
                    </Badge>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatDate(statuses.find((s) => s.provider === p.id)?.updatedAt)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Label htmlFor={`key-${p.id}`} className="sr-only">
                        {p.label} key
                      </Label>
                      <Input
                        id={`key-${p.id}`}
                        type="password"
                        autoComplete="off"
                        placeholder={configured(p.id) ? 'Rotate with a new key' : 'Paste key'}
                        value={inputs[p.id] ?? ''}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        className="max-w-xs"
                      />
                      <Button type="button" variant="outline" size="sm" disabled={!!pending[p.id]} onClick={() => save(p.id)}>
                        {pending[p.id] ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {configured(p.id) ? (
                      <Button type="button" variant="ghost" size="sm" disabled={!!pending[p.id]} onClick={() => remove(p.id)}>
                        Remove
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ChatgptSection />
    </div>
  );
}
