'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getDefaultApi, type GithubInstallResult } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { Button } from '@/components/ui/button';

/** The App's first Callback URL: GitHub returns here with an OAuth code, usually the installation, and maybe the state. */
const STATE_KEY = 'dock:github-install-state';

function InstalledBody() {
  const params = useSearchParams();
  const rawInstallation = params.get('installation_id');
  const installationId = rawInstallation ? Number(rawInstallation) : undefined;
  const code = params.get('code');
  const [api] = useState(getDefaultApi);
  const [done, setDone] = useState(false);
  const [candidates, setCandidates] = useState<NonNullable<GithubInstallResult['candidates']>>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const invalid = !code || (installationId !== undefined && (!Number.isInteger(installationId) || installationId < 1));

  function finish(result: GithubInstallResult) {
    if (result.candidates) setCandidates(result.candidates);
    else setDone(true);
  }

  // The code and pending link are single-use, so strict-mode effect replays must not spend them twice.
  useEffect(() => {
    if (invalid || started.current) return;
    started.current = true;
    const state = params.get('state') ?? window.sessionStorage.getItem(STATE_KEY) ?? undefined;
    window.sessionStorage.removeItem(STATE_KEY);
    api
      .completeGithubInstall({ code: code ?? undefined, installationId, state })
      .then(finish)
      .catch((e: unknown) => setError(messageOf(e, 'Could not link the installation.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, code, installationId, params, invalid]);

  function pick(id: number) {
    setError(null);
    api
      .completeGithubInstall({ installationId: id })
      .then((r) => {
        setCandidates([]);
        finish(r);
      })
      .catch((e: unknown) => {
        setCandidates([]);
        setError(messageOf(e, 'Could not link the installation.'));
      });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Linking installation" description="Finishing the GitHub App link for your workspace." />
      {invalid ? (
        <ErrorNote message="This page needs the authorization code GitHub returns after you install the App. Start from Link installation." />
      ) : error ? (
        <ErrorNote message={error} />
      ) : done ? (
        <p className="text-sm">Installation linked.</p>
      ) : candidates.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">Choose the installation to link.</p>
          {candidates.map((c) => (
            <div key={c.installationId}>
              <Button type="button" variant="outline" onClick={() => pick(c.installationId)}>
                {c.account}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <LoadingRows rows={2} />
      )}
      <div>
        <Button type="button" variant="outline" nativeButton={false} render={<Link href="/developers/github" />}>
          Back to GitHub App
        </Button>
      </div>
    </div>
  );
}

export default function GithubInstalledPage() {
  return (
    <Suspense>
      <InstalledBody />
    </Suspense>
  );
}
