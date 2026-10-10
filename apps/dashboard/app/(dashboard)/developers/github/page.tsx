'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, Plus } from 'lucide-react';
import { getDefaultApi } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrg } from '@/components/dashboard/org-context';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { isPrivateUrl, PrivateUrlNotice } from '@/components/dashboard/github-public-url';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Installation {
  id: string;
  installationId?: number;
  workspaceId?: string;
  repos?: string[];
  agent?: string;
  testCommand?: string | null;
  createdAt?: string;
}

interface GuideStep {
  title: string;
  body: ReactNode;
  /** Undefined when the dashboard cannot observe the step. */
  done?: boolean;
}

const code = 'font-mono text-foreground';
const link = 'text-foreground underline underline-offset-4';

/** End-to-end setup checklist; ticks the steps this instance can verify. */
function SetupGuide({ apiUrl, appUrl, appConfigured, linked }: { apiUrl: string; appUrl: string; appConfigured: boolean; linked: boolean }) {
  const steps: GuideStep[] = [
    {
      title: 'Expose the API publicly',
      body: (
        <>
          GitHub delivers webhooks to <span className={code}>{apiUrl}/v1/github/webhooks</span>, so that URL must be
          reachable from the internet over HTTPS. Localhost and private addresses do not work.
        </>
      ),
      done: !isPrivateUrl(apiUrl),
    },
    {
      title: 'Register the App',
      body: (
        <>
          An instance admin (listed in <span className={code}>INSTANCE_ADMIN_EMAILS</span> with a verified email; without SMTP the verification link is in <span className={code}>docker compose logs backend</span>) opens{' '}
          <Link href="/developers/github/setup" className={link}>
            Register App
          </Link>{' '}
          and approves it on GitHub.
        </>
      ),
      done: appConfigured,
    },
    {
      title: 'Add the credentials',
      body: (
        <>
          Paste the printed <span className={code}>GITHUB_APP_*</span> lines into the backend env file and restart the
          backend. This step ticks once the backend sees them.
        </>
      ),
      done: appConfigured,
    },
    {
      title: 'Check the App callback',
      body: (
        <>
          Set the App&apos;s first Callback URL to <span className={code}>{appUrl}/developers/github/installed</span>, enable
          Request user authorization (OAuth) during installation, and add the Members (read) organization permission
          (Apps registered here already have all of it).
        </>
      ),
    },
    {
      title: 'Link the installation',
      body: (
        <>
          Click <span className="text-foreground">Link installation</span>, install the App on the repositories Dock
          should work in, and GitHub returns you here. Runs bill and provision in the selected workspace.
        </>
      ),
      done: linked,
    },
    {
      title: 'Add a provider key',
      body: (
        <>
          The run agent needs a model. Add an org key on{' '}
          <Link href="/developers/provider-keys" className={link}>
            Provider keys
          </Link>
          , or connect your own ChatGPT subscription there for runs you start.
        </>
      ),
    },
    {
      title: 'Mention @dock on an issue',
      body: (
        <>
          A collaborator with write access comments <span className={code}>@dock fix this</span> on an issue. Follow
          the work on{' '}
          <Link href="/runs" className={link}>
            Runs
          </Link>
          ; Dock replies on the issue with a pull request.
        </>
      ),
    },
  ];
  return (
    <section className="rounded-md border">
      <h2 className="border-b px-4 py-3 text-sm font-medium">Setup guide</h2>
      <ol className="flex flex-col divide-y">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3 px-4 py-3">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs',
                step.done && 'border-primary bg-primary text-primary-foreground',
              )}
            >
              {step.done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <div className="flex flex-col gap-1">
              <span className={cn('text-sm font-medium', step.done && 'text-muted-foreground')}>{step.title}</span>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** GitHub App installations mapping repos to workspaces. Setup, low traffic. */
export default function GithubAppPage() {
  const { workspaces, selectedWorkspaceId } = useOrg();
  const [api] = useState(getDefaultApi);
  const instance = useInstanceConfig();
  const appMissing = instance?.githubAppConfigured === false;
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  // The scope gate in render covers the unselected case; no sync resets.
  const refresh = useCallback(() => {
    if (!selectedWorkspaceId) return;
    api
      .listInstallations(selectedWorkspaceId)
      .then((rows) => {
        setInstallations(rows as Installation[]);
        setError(null);
      })
      .catch((e: unknown) => {
        setInstallations([]);
        setError(messageOf(e, 'Could not load installations.'));
      });
  }, [api, selectedWorkspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const workspaceForLink = selectedWorkspaceId || workspaces[0]?.id || '';

  async function link(mode?: 'authorize') {
    if (!workspaceForLink) return;
    setLinking(true);
    setActionError(null);
    try {
      const { url, state } = await api.startGithubInstall(workspaceForLink, mode);
      // GitHub may not echo the state back through the OAuth callback.
      window.sessionStorage.setItem('dock:github-install-state', state);
      window.location.assign(url);
    } catch (e: unknown) {
      setActionError(`Could not start linking: ${messageOf(e, 'request failed')}`);
      setLinking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="GitHub App"
        description="Link an installed GitHub App to a workspace so @dock mentions become runs."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={appMissing ? 'default' : 'outline'}
              nativeButton={false}
              render={<Link href="/developers/github/setup" />}
            >
              Register App
            </Button>
            <Button type="button" variant="outline" disabled={!selectedWorkspaceId || linking} onClick={() => link('authorize')}>
              Link existing installation
            </Button>
            <Button type="button" disabled={!selectedWorkspaceId || linking} onClick={() => link()}>
              <Plus />
              {linking ? 'Opening GitHub…' : 'Link installation'}
            </Button>
          </div>
        }
      />
      {instance && isPrivateUrl(instance.apiUrl) ? <PrivateUrlNotice apiUrl={instance.apiUrl} /> : null}
      {instance && (appMissing || installations?.length === 0) ? (
        <SetupGuide
          apiUrl={instance.apiUrl}
          appUrl={instance.appUrl}
          appConfigured={instance.githubAppConfigured}
          linked={Boolean(installations?.length)}
        />
      ) : null}

      {actionError ? <ErrorNote message={actionError} /> : null}
      {!selectedWorkspaceId ? (
        <EmptyNote title="Pick a workspace." hint="Installations bill and provision in one workspace." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : installations === null ? (
        <LoadingRows />
      ) : installations.length === 0 ? (
        <EmptyNote title="No installations linked." hint="Install the app on GitHub, then link it to this workspace." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Installation</TableHead>
                <TableHead>Repos</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {installations.map((inst) => (
                <TableRow key={inst.id}>
                  <TableCell className="font-mono text-sm">#{inst.installationId ?? inst.id.slice(0, 8)}</TableCell>
                  <TableCell className="text-sm">{(inst.repos ?? []).join(', ') || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{inst.agent ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        api
                          .removeInstallation(inst.id)
                          .then(() => refresh())
                          .catch((e: unknown) =>
                            setActionError(`Could not unlink: ${messageOf(e, 'request failed')}`),
                          )
                      }
                    >
                      Unlink
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
