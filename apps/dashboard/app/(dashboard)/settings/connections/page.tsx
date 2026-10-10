'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { getDefaultApi, type Me } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { SOCIAL_PROVIDERS, type SocialProvider } from '@/components/auth/social-buttons';
import { ErrorNote, LoadingRows } from '@/components/dashboard/data-states';
import { SettingsSection } from '@/components/dashboard/settings-section';
import { Button } from '@/components/ui/button';

interface Connection {
  id: string;
  provider: string;
  identifier: string;
  primary: boolean;
  linkedAt: string;
}

/** What a linked GitHub account is for beyond signing in. */
const PURPOSE: Partial<Record<string, string>> = {
  github: 'Matches your @dock mentions to you, so runs can use your ChatGPT subscription.',
};

function isSocial(provider: string): provider is SocialProvider {
  return provider in SOCIAL_PROVIDERS;
}

function ProviderMark({ provider }: { provider: string }) {
  if (!isSocial(provider)) return null;
  const { Mark } = SOCIAL_PROVIDERS[provider];
  return <Mark />;
}

function MethodRow({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-4 px-5 py-3.5">
      <span className="flex size-9 items-center justify-center rounded-md border">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </div>
      {action}
    </li>
  );
}

/** Sign-in methods: the password login plus linked social accounts. Linking GitHub also attributes @dock mentions. */
export default function ConnectionsPage() {
  const [api] = useState(getDefaultApi);
  const instance = useInstanceConfig();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // Settles state only from async continuations; render starts unloaded.
  const refresh = useCallback(() => {
    api
      .listConnections()
      .then((r) => {
        setConnections(r.connections as Connection[]);
        setError(null);
      })
      .catch((e: unknown) => {
        setConnections([]);
        setError(messageOf(e, 'Could not load connections.'));
      });
    api
      .getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function link(provider: SocialProvider) {
    setPending(provider);
    setActionError(null);
    try {
      const out = await authClient.linkSocial({ provider, callbackURL: window.location.href });
      if (out.error) throw new Error(out.error.message ?? 'link failed');
    } catch (e: unknown) {
      setActionError(`Could not link ${SOCIAL_PROVIDERS[provider].label}: ${messageOf(e, 'request failed')}`);
      setPending(null);
    }
  }

  async function unlink(c: Connection) {
    setPending(c.id);
    setActionError(null);
    try {
      await api.removeConnection(c.id);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not remove connection: ${messageOf(e, 'request failed')}`);
    } finally {
      setPending(null);
    }
  }

  const linked = new Set((connections ?? []).map((c) => c.provider));
  const available = (instance?.authProviders ?? []).filter((p) => !linked.has(p));
  const githubOff = instance !== null && !instance.authProviders.includes('github') && !linked.has('github');

  return (
    <SettingsSection
      title="Sign-in methods"
      description="Ways you can sign in to Dock. Linking an account also lets Dock recognize you there."
      flush
      footerHint={
        githubOff ? (
          <>
            GitHub sign-in is not set up on this instance. An operator can add{' '}
            <span className="font-mono">BETTER_AUTH_GITHUB_CLIENT_ID</span> and{' '}
            <span className="font-mono">_SECRET</span> so members can link GitHub for @dock runs.
          </>
        ) : null
      }
    >
      {actionError ? (
        <div className="px-5 pt-4">
          <ErrorNote message={actionError} />
        </div>
      ) : null}
      {error ? (
        <div className="p-5">
          <ErrorNote message={error} onRetry={refresh} />
        </div>
      ) : connections === null ? (
        <div className="p-5">
          <LoadingRows rows={2} />
        </div>
      ) : (
        <ul className="divide-y">
          {connections.map((c) =>
            c.primary ? (
              <MethodRow
                key={c.id}
                icon={<KeyRound className="size-4" />}
                title="Email and password"
                detail={me?.email ?? 'Your account email'}
                action={<span className="text-xs text-muted-foreground">Primary, always on</span>}
              />
            ) : (
              <MethodRow
                key={c.id}
                icon={<ProviderMark provider={c.provider} />}
                title={isSocial(c.provider) ? SOCIAL_PROVIDERS[c.provider].label : c.provider}
                detail={PURPOSE[c.provider] ?? `Linked ${formatDate(c.linkedAt)}`}
                action={
                  <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => unlink(c)}>
                    {pending === c.id ? 'Removing…' : 'Disconnect'}
                  </Button>
                }
              />
            ),
          )}
          {available.map((provider) => {
            const { label, Mark } = SOCIAL_PROVIDERS[provider];
            return (
              <MethodRow
                key={provider}
                icon={<Mark />}
                title={label}
                detail={PURPOSE[provider] ?? 'Not linked.'}
                action={
                  <Button type="button" size="sm" disabled={pending !== null} onClick={() => link(provider)}>
                    {pending === provider ? 'Redirecting…' : `Connect ${label}`}
                  </Button>
                }
              />
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
}
