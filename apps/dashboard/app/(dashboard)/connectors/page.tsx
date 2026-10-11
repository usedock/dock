'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDefaultApi, type Connector, type ConnectorCredentialType } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.usedock.io';

interface Entry {
  label: string;
  blurb: string;
  /** Where to get a token; shown in the token form. */
  tokenHint?: string;
  /** Read-only entries are managed on their own page. */
  manageHref?: string;
}

const ENTRIES: Record<string, Entry> = {
  figma: {
    label: 'Figma',
    blurb: 'Read files, components and comments from a dock.',
    tokenHint: 'Figma, Settings, Security, Personal access tokens. Starts with figd_.',
  },
  linear: {
    label: 'Linear',
    blurb: 'Query and update issues through the Linear API.',
    tokenHint: 'Linear, Settings, Account, Security, Personal API keys. Starts with lin_api_.',
  },
  slack: {
    label: 'Slack',
    blurb: 'Call the Slack Web API with a bot token.',
    tokenHint: 'Your Slack app, OAuth & Permissions, Bot User OAuth Token. Starts with xoxb-.',
  },
  sentry: {
    label: 'Sentry',
    blurb: 'Read projects and issues from Sentry.',
    tokenHint: 'Sentry, Settings, Developer Settings, Personal Tokens. Starts with sntrys_.',
  },
  github: {
    label: 'GitHub',
    blurb: 'The GitHub App installation that clones repos and runs @dock.',
    manageHref: '/developers/github',
  },
  'model-keys': {
    label: 'Model keys',
    blurb: 'Provider keys the run agents use.',
    manageHref: '/developers/provider-keys',
  },
};

const REASONS: Record<string, string> = {
  denied: 'You declined the request on the tool.',
  session_mismatch: 'You were signed in as a different user than the one who started the connection. Try again.',
  invalid_state: 'The connection request expired. Start again.',
  oauth_not_configured: 'OAuth is not configured for this tool on this instance.',
  connector_admin_only: 'Only organization admins can connect tools.',
  forbidden: 'Only organization admins can connect tools.',
  connector_token_invalid: 'The tool rejected the credential.',
  connector_unreachable: 'The tool could not be reached.',
};

const CREDENTIAL_LABELS: Record<ConnectorCredentialType, string> = {
  oauth: 'OAuth',
  personal_token: 'Personal token',
  bot_token: 'Bot token',
  org_token: 'Organization token',
  user_token: 'User token',
  token: 'Token',
};

/** Tokens that act as one person: runs and agents are attributed to them. */
const ACTS_AS_PERSON: ReadonlySet<ConnectorCredentialType> = new Set(['personal_token', 'user_token']);

function statusBadge(c: Connector) {
  if (c.status === 'connected') return <Badge>Connected</Badge>;
  if (c.status === 'reauth_required') return <Badge variant="destructive">Reconnect needed</Badge>;
  return <Badge variant="outline">Not connected</Badge>;
}

function ConnectorsView() {
  const { organizations, selectedOrgId, selectedWorkspaceId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const [api] = useState(getDefaultApi);
  const [items, setItems] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<Connector | null>(null);
  const [token, setToken] = useState('');
  const [disconnecting, setDisconnecting] = useState<Connector | null>(null);

  const role = organizations.find((o) => o.id === selectedOrgId)?.role;
  const isAdmin = role === 'admin' || role === 'owner';

  // OAuth callback result: kept in state, then the query is dropped from the URL.
  const [notice] = useState(() => {
    const status = params.get('status');
    if (status !== 'connected' && status !== 'error') return null;
    // Only known kinds and reason codes are shown, so a crafted link cannot put its own text on the page.
    const kind = params.get('kind') ?? '';
    const reason = params.get('reason') ?? '';
    return {
      status,
      label: ENTRIES[kind]?.label ?? 'the tool',
      message: REASONS[reason] ?? (/^[a-z_]{1,40}$/.test(reason) ? `Something went wrong (${reason}).` : 'Something went wrong.'),
    };
  });
  useEffect(() => {
    if (notice) router.replace('/connectors');
  }, [notice, router]);

  const refresh = useCallback(() => {
    if (!selectedWorkspaceId) return;
    api
      .listConnectors(selectedWorkspaceId)
      .then((rows) => {
        setItems(rows);
        setError(null);
      })
      .catch((e: unknown) => {
        setItems([]);
        setError(messageOf(e, 'Could not load connectors.'));
      });
  }, [api, selectedWorkspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function startOauth(c: Connector) {
    if (!selectedWorkspaceId) return;
    setBusy(c.kind);
    setActionError(null);
    try {
      const { url } = await api.startConnectorOauth(selectedWorkspaceId, c.kind);
      window.location.assign(url);
    } catch (e: unknown) {
      setActionError(`Could not start sign-in: ${messageOf(e, 'request failed')}`);
      setBusy(null);
    }
  }

  async function saveToken() {
    if (!selectedWorkspaceId || !tokenFor) return;
    setBusy(tokenFor.kind);
    setActionError(null);
    try {
      await api.connectConnector(selectedWorkspaceId, tokenFor.kind, token.trim());
      setTokenFor(null);
      setToken('');
      refresh();
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      setActionError(`Could not connect: ${(code && REASONS[code]) || messageOf(e, 'request failed')}`);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(c: Connector) {
    if (!selectedWorkspaceId) return;
    setBusy(c.kind);
    setActionError(null);
    try {
      await api.disconnectConnector(selectedWorkspaceId, c.kind);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not disconnect: ${messageOf(e, 'request failed')}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Connectors"
        description="Give docks access to your tools without putting the credential inside the dock."
        action={
          <Button
            type="button"
            variant="outline"
            nativeButton={false}
            render={<a href={`${DOCS_URL}/connectors`} target="_blank" rel="noreferrer" />}
          >
            Docs
          </Button>
        }
      />

      {notice ? (
        <Alert variant={notice.status === 'error' ? 'destructive' : 'default'}>
          <AlertTitle>
            {notice.status === 'connected' ? `${notice.label} connected.` : `Could not connect ${notice.label}.`}
          </AlertTitle>
          {notice.status === 'error' ? <AlertDescription>{notice.message}</AlertDescription> : null}
        </Alert>
      ) : null}
      {!isAdmin && selectedOrgId ? (
        <p className="text-sm text-muted-foreground">
          Only organization admins can connect or disconnect tools. You can see their status.
        </p>
      ) : null}
      {actionError && !tokenFor ? <ErrorNote message={actionError} /> : null}

      {!selectedWorkspaceId ? (
        <EmptyNote title="Pick a workspace." hint="Connectors belong to one workspace." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : items === null ? (
        <LoadingRows />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((c) => {
            const entry = ENTRIES[c.kind] ?? { label: c.kind, blurb: '' };
            const connected = c.status !== 'not_connected';
            return (
              <section key={c.kind} className="flex flex-col gap-3 rounded-md border p-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium">{entry.label}</h2>
                    <p className="text-sm text-muted-foreground">{entry.blurb}</p>
                  </div>
                  {statusBadge(c)}
                </div>
                {connected ? (
                  <p className="text-xs text-muted-foreground">
                    {[c.kind === 'model-keys' ? c.scopes.join(', ') : c.accountLabel, c.updatedAt ? `updated ${formatDate(c.updatedAt)}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                {connected && c.credentialType ? (
                  <p className="text-xs text-muted-foreground">Credential: {CREDENTIAL_LABELS[c.credentialType]}</p>
                ) : null}
                {connected && c.credentialType && ACTS_AS_PERSON.has(c.credentialType) ? (
                  <Alert>
                    <AlertTitle>Acts as {c.accountLabel ?? 'the token owner'}</AlertTitle>
                    <AlertDescription>
                      Runs and agents act as {c.accountLabel ?? 'the token owner'}; anything the agent does is attributed to that person. Prefer OAuth or a
                      bot/app token.{' '}
                      <a
                        className="text-foreground underline underline-offset-4"
                        href={`${DOCS_URL}/connectors#credential-types`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Credential types
                      </a>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  {c.readOnly ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={entry.manageHref ?? '/developers'} />}
                    >
                      Manage
                    </Button>
                  ) : (
                    <>
                      {c.oauthAvailable ? (
                        <Button type="button" size="sm" disabled={!isAdmin || busy === c.kind} onClick={() => startOauth(c)}>
                          {connected ? 'Reconnect' : 'Connect'}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant={c.oauthAvailable ? 'outline' : 'default'}
                        disabled={!isAdmin || busy === c.kind}
                        onClick={() => {
                          setToken('');
                          setActionError(null);
                          setTokenFor(c);
                        }}
                      >
                        {c.oauthAvailable ? 'Use a token' : connected ? 'Replace token' : 'Connect'}
                      </Button>
                      {connected ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={!isAdmin || busy === c.kind}
                          onClick={() => setDisconnecting(c)}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={tokenFor !== null} onOpenChange={(open) => !open && setTokenFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {tokenFor ? ENTRIES[tokenFor.kind]?.label : ''}</DialogTitle>
            <DialogDescription>
              The token is checked against the tool, then stored encrypted. It is never shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-token">Token</Label>
            <Input
              id="connector-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {tokenFor ? ENTRIES[tokenFor.kind]?.tokenHint : null}{' '}
              <a
                className="text-foreground underline underline-offset-4"
                href={`${DOCS_URL}/connectors/${tokenFor?.kind ?? ''}`}
                target="_blank"
                rel="noreferrer"
              >
                Setup guide
              </a>
            </p>
          </div>
          {actionError ? <ErrorNote message={actionError} /> : null}
          <DialogFooter>
            <Button type="button" disabled={!token.trim() || busy !== null} onClick={saveToken}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={disconnecting !== null} onOpenChange={(open) => !open && setDisconnecting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {disconnecting ? ENTRIES[disconnecting.kind]?.label : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              The stored credential is deleted. Docks that use it lose access to the tool right away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = disconnecting;
                setDisconnecting(null);
                if (target) void disconnect(target);
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Workspace tool connections: connect with OAuth or a token, see status, disconnect. */
export default function ConnectorsPage() {
  return (
    <Suspense fallback={<LoadingRows />}>
      <ConnectorsView />
    </Suspense>
  );
}
