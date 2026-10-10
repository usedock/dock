'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getDefaultApi, type GithubAppCredentials, type GithubAppManifestStart } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { CodeBlock } from '@/components/dashboard/code-block';
import { ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { isPrivateUrl, PrivateUrlNotice } from '@/components/dashboard/github-public-url';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Shows the new App's credentials once; GitHub never returns them again. */
function Credentials({ app }: { app: GithubAppCredentials }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Registered <span className="font-mono">{app.slug}</span>
        {app.owner ? ` for ${app.owner}` : ''}. Copy these into the backend env now; this page cannot show the
        private key again.
      </p>
      <CodeBlock lines={app.envFile.split('\n')} />
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>Add the lines above to the backend env file and restart the backend.</li>
        <li>
          <a href={app.installUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
            Install the App
          </a>{' '}
          on the repositories Dock should work in.
        </li>
        <li>
          Link the installation to a workspace on the{' '}
          <Link href="/developers/github" className="text-foreground underline underline-offset-4">
            GitHub App
          </Link>{' '}
          page.
        </li>
      </ol>
    </div>
  );
}

function SetupBody() {
  const params = useSearchParams();
  const code = params.get('code');
  const state = params.get('state');
  const [api] = useState(getDefaultApi);
  const instance = useInstanceConfig();
  const [organization, setOrganization] = useState('');
  const [manifest, setManifest] = useState<GithubAppManifestStart | null>(null);
  const [app, setApp] = useState<GithubAppCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const converted = useRef(false);
  const unreachable = instance ? isPrivateUrl(instance.apiUrl) : false;

  // The code is single-use, so strict-mode effect replays must not spend it twice.
  useEffect(() => {
    if (!code || !state || converted.current) return;
    converted.current = true;
    api
      .convertGithubAppSetup(code, state)
      .then(setApp)
      .catch((e: unknown) => setError(messageOf(e, 'Could not finish the GitHub App registration.')));
  }, [api, code, state]);

  // GitHub only accepts the manifest as a browser form POST.
  useEffect(() => {
    if (manifest) formRef.current?.submit();
  }, [manifest]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setManifest(await api.startGithubAppSetup(organization.trim() || undefined));
    } catch (e: unknown) {
      setError(messageOf(e, 'Could not start the GitHub App registration.'));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Register a GitHub App"
        description="Create this instance's own GitHub App through GitHub's manifest flow. Instance admins only."
      />
      {unreachable && instance ? <PrivateUrlNotice apiUrl={instance.apiUrl} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {app ? (
        <Credentials app={app} />
      ) : code ? (
        error ? null : <LoadingRows rows={2} />
      ) : (
        <div className="flex max-w-md flex-col gap-4">
          {instance?.githubAppConfigured ? (
            <p className="text-sm text-muted-foreground">
              A GitHub App is already configured. Registering another replaces it only after you update the backend env.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            The App sends webhooks to <span className="font-mono">{instance?.apiUrl ?? 'this API'}/v1/github/webhooks</span>{' '}
            and asks for contents, pull requests, and issues write access plus metadata read.
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="gh-org">GitHub organization (optional)</Label>
            <Input
              id="gh-org"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="Leave empty to register on your account"
            />
          </div>
          <div>
            <Button type="button" disabled={busy || unreachable} onClick={start}>
              {busy ? 'Opening GitHub…' : 'Register on GitHub'}
            </Button>
          </div>
          {manifest ? (
            <form ref={formRef} method="post" action={manifest.postUrl} className="hidden">
              <input type="hidden" name="manifest" value={manifest.manifest} />
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function GithubAppSetupPage() {
  return (
    <Suspense>
      <SetupBody />
    </Suspense>
  );
}
