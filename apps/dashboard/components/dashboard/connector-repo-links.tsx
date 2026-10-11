'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDefaultApi, type ConnectorRepoLink } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { ErrorNote } from '@/components/dashboard/data-states';
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
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.usedock.io';

/** What the scope of a link means for each tool; the API accepts these as opaque ids. */
const SCOPE_HINTS: Record<string, { noun: string; example: string }> = {
  linear: { noun: 'Linear team id', example: 'the id of a team' },
  slack: { noun: 'Slack channel id', example: 'C0123456789' },
  sentry: { noun: 'Sentry project slug', example: 'web-api' },
  figma: { noun: 'Figma file key', example: 'the key in the file URL' },
};

const ERROR_TEXT: Record<string, string> = {
  validation_error: 'Check the scope and repository. The repository must look like owner/name.',
  connector_not_found: 'Connect this tool before linking a repository.',
  repo_link_not_found: 'That link no longer exists.',
  github_app_not_configured: 'The GitHub App is not configured on this instance.',
  github_installation_missing: 'Install the Dock GitHub App on a repository in this workspace first.',
  github_permissions_missing: 'The Dock GitHub App needs Contents and Pull requests write access on that repository.',
  github_repo_not_accessible: 'No GitHub App installation of this workspace can access that repository.',
  forbidden: 'Only organization admins can manage repository links.',
};

function errorText(e: unknown, fallback: string): string {
  const code = (e as { code?: string }).code;
  return (code && ERROR_TEXT[code]) || messageOf(e, fallback);
}

/** Repositories each trigger of a connected tool may open pull requests in. Admin only: the API refuses members. */
export function ConnectorRepoLinks({
  workspaceId,
  kind,
  label,
  isAdmin,
}: {
  workspaceId: string;
  kind: string;
  label: string;
  isAdmin: boolean;
}) {
  const [api] = useState(getDefaultApi);
  const [links, setLinks] = useState<ConnectorRepoLink[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState('*');
  const [repo, setRepo] = useState('');
  const [repos, setRepos] = useState<string[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ConnectorRepoLink | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const hint = SCOPE_HINTS[kind] ?? { noun: 'scope id', example: 'an id' };

  const refresh = useCallback(() => {
    api
      .listConnectorRepoLinks(workspaceId, kind)
      .then(({ links: rows }) => {
        setLinks(rows);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        setLinks([]);
        setLoadError(errorText(e, 'Could not load repository links.'));
      });
  }, [api, workspaceId, kind]);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  function openAdd() {
    setScope('*');
    setRepo('');
    setFormError(null);
    setReposError(null);
    setRepos(null);
    setAdding(true);
    api
      .listInstallations(workspaceId)
      .then((rows) => {
        const names = new Set<string>();
        for (const inst of rows as Array<{ repos?: string[] }>) for (const r of inst.repos ?? []) names.add(r);
        setRepos([...names].sort());
      })
      .catch((e: unknown) => {
        setRepos([]);
        setReposError(messageOf(e, 'Could not load the repositories of your GitHub installations.'));
      });
  }

  async function save() {
    setBusy(true);
    setFormError(null);
    try {
      await api.putConnectorRepoLink(workspaceId, kind, { scope: scope.trim(), repo: repo.trim() });
      setAdding(false);
      refresh();
    } catch (e: unknown) {
      setFormError(errorText(e, 'Could not save the link.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(link: ConnectorRepoLink) {
    setBusy(true);
    setRemoveError(null);
    try {
      await api.removeConnectorRepoLink(workspaceId, kind, link.scope);
      setRemoving(null);
      refresh();
    } catch (e: unknown) {
      setRemoveError(errorText(e, 'Could not remove the link.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid={`repo-links-${kind}`}>
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-xs font-medium">Repositories</h3>
        {isAdmin ? (
          <Button type="button" size="sm" variant="outline" onClick={openAdd}>
            Add link
          </Button>
        ) : null}
      </div>
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Only organization admins can view or change which repositories this tool links to.</p>
      ) : loadError ? (
        <ErrorNote message={loadError} onRetry={refresh} />
      ) : links === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : links.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No repository linked. Triggered {label} runs cannot open pull requests until you add one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {links.map((l) => (
            <li key={l.scope} className="flex items-center gap-2 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-mono">{l.scope === '*' ? '* (any)' : l.scope}</span>
                  <span className="text-muted-foreground"> → </span>
                  <span className="font-mono">{l.repo}</span>
                </p>
                <p className="text-muted-foreground">added {formatDate(l.createdAt)}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove link ${l.scope} to ${l.repo}`}
                onClick={() => {
                  setRemoveError(null);
                  setRemoving(l);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={adding} onOpenChange={(open) => !open && setAdding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link a repository to {label}</DialogTitle>
            <DialogDescription>Runs started from this tool open their pull requests in the linked repository.</DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTitle>Anyone who can start a run gets this repository</AlertTitle>
            <AlertDescription>
              A link lets anyone who can start a run read the repository and trigger its CI with its secrets.{' '}
              <a
                className="text-foreground underline underline-offset-4"
                href={`${DOCS_URL}/connectors/triggers`}
                target="_blank"
                rel="noreferrer"
              >
                Read the security notes
              </a>
            </AlertDescription>
          </Alert>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`repo-link-scope-${kind}`}>Scope</Label>
            <Input
              id={`repo-link-scope-${kind}`}
              autoComplete="off"
              spellCheck={false}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A {hint.noun} ({hint.example}), or <span className="font-mono text-foreground">*</span> for every one without its own link.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`repo-link-repo-${kind}`}>Repository</Label>
            {repos !== null && repos.length > 0 ? (
              <NativeSelect id={`repo-link-repo-${kind}`} className="w-full" value={repo} onChange={(e) => setRepo(e.target.value)}>
                <NativeSelectOption value="">Choose a repository</NativeSelectOption>
                {repos.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {r}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <Input
                id={`repo-link-repo-${kind}`}
                autoComplete="off"
                spellCheck={false}
                placeholder="owner/name"
                disabled={repos === null}
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            )}
            <p className="text-xs text-muted-foreground">
              {reposError ??
                (repos !== null && repos.length === 0
                  ? 'No repositories found on your GitHub installations. Install the Dock GitHub App from Developers, GitHub, or type owner/name.'
                  : 'Repositories your workspace GitHub App installations can reach.')}
            </p>
          </div>
          {formError ? <ErrorNote message={formError} /> : null}
          <DialogFooter>
            <Button type="button" disabled={!scope.trim() || !repo.trim() || busy} onClick={save}>
              {busy ? 'Saving…' : 'Save link'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this link?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing
                ? `${removing.scope === '*' ? 'Runs without a more specific link' : `Runs for ${removing.scope}`} stop opening pull requests in ${removing.repo}.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? <ErrorNote message={removeError} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (removing) void remove(removing);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
