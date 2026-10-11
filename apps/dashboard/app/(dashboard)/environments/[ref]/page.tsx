'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { getDefaultApi, type Environment, type EnvironmentVersion, type RevealedSecrets } from '@/lib/dock-api';
import { formatBytes, formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const TABS = ['repos', 'vars', 'settings', 'versions', 'secrets'] as const;

type PostureKey = 'passSecrets' | 'passGithub' | 'passAgentsCredentials' | 'passDockCredentials' | 'safeForThirdParties';


const POSTURE: { key: PostureKey; label: string; hint: string }[] = [
  { key: 'passSecrets', label: 'Variables and files', hint: 'Write this environment’s variables and secret files into docks.' },
  { key: 'passGithub', label: 'Repositories', hint: 'Clone the selected repositories into docks.' },
  { key: 'passAgentsCredentials', label: 'Provider keys', hint: 'Fill missing agent keys from the organization’s provider keys.' },
  {
    key: 'passDockCredentials',
    label: 'Dock API key',
    hint: 'Give each dock a DOCK_API_KEY acting as its creator, so code inside can drive Dock. Rotated on every apply, revoked with the dock.',
  },
  {
    key: 'safeForThirdParties',
    label: 'Safe for third parties',
    hint: 'Withhold everything above, for docks other people drive. Overrides the other switches.',
  },
];

/** One environment: what docks boot with, how it is passed, and its version history. */
function EnvironmentDetail() {
  const { ref } = useParams<{ ref: string }>();
  const name = decodeURIComponent(ref);
  const router = useRouter();
  const params = useSearchParams();
  const { selectedOrgId, organizations } = useOrg();
  const isAdmin = ['admin', 'owner'].includes(organizations.find((o) => o.id === selectedOrgId)?.role ?? '');
  const [api] = useState(getDefaultApi);

  const tab = params.get('tab') ?? 'repos';
  const [env, setEnv] = useState<Environment | null>(null);
  const [versions, setVersions] = useState<EnvironmentVersion[] | null>(null);
  const [revealed, setRevealed] = useState<RevealedSecrets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [repoProvider, setRepoProvider] = useState('github');
  const [repoFullName, setRepoFullName] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [repoSetup, setRepoSetup] = useState('');
  const [varKey, setVarKey] = useState('');
  const [varValue, setVarValue] = useState('');
  const [filePath, setFilePath] = useState('');
  const [fileContents, setFileContents] = useState('');
  const [egressText, setEgressText] = useState<string | null>(null);

  const setTab = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('tab', value);
      router.replace(`/environments/${encodeURIComponent(name)}?${next.toString()}`);
    },
    [name, params, router],
  );

  // Settles state only from async continuations; render starts unloaded.
  const refresh = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .getEnvironment(name, selectedOrgId)
      .then((row) => {
        setEnv(row);
        setError(null);
      })
      .catch((e: unknown) => setError(messageOf(e, 'Could not load environment.')));
    api
      .listEnvironmentVersions(name, selectedOrgId)
      .then((rows) => setVersions(rows))
      .catch(() => setVersions([]));
  }, [api, name, selectedOrgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runAction(fn: () => Promise<unknown>, failure: string, done?: string) {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      refresh();
      return true;
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
      return false;
    }
  }

  function reveal() {
    if (!selectedOrgId) return;
    setActionError(null);
    api
      .revealSecrets(name, selectedOrgId)
      .then((values) => setRevealed(values))
      .catch((e: unknown) => setActionError(`Could not reveal secrets: ${messageOf(e, 'request failed')}`));
  }

  async function remove() {
    if (!selectedOrgId) return;
    setConfirmDelete(false);
    setActionError(null);
    try {
      await api.deleteEnvironment(name, selectedOrgId);
      router.push('/environments');
    } catch (e: unknown) {
      setActionError(`Could not delete environment: ${messageOf(e, 'request failed')}`);
    }
  }

  const outdated = (versions ?? []).filter((v) => env && v.version < env.currentVersion && v.dockCount > 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={name}
        description="What docks in this environment boot with. Each content change saves a new version; existing docks keep theirs until upgraded."
        action={
          env ? (
            <div className="flex items-center gap-2">
              {env.isDefault ? <Badge variant="secondary">default</Badge> : null}
              <Badge variant="outline" className="font-mono">
                v{env.currentVersion}
              </Badge>
            </div>
          ) : null
        }
      />
      {actionError ? <ErrorNote message={actionError} /> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      {!selectedOrgId ? (
        <EmptyNote title="Pick an organization." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : env === null ? (
        <LoadingRows />
      ) : (
        <Tabs value={TABS.includes(tab as (typeof TABS)[number]) ? tab : 'repos'} onValueChange={setTab}>
          <TabsList aria-label="Environment sections">
            <TabsTrigger value="repos">Repositories</TabsTrigger>
            <TabsTrigger value="vars">Variables & files</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="secrets">Reveal</TabsTrigger>
          </TabsList>

          <TabsContent value="repos" className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="repo-provider">Provider</Label>
                <Select value={repoProvider} onValueChange={(v) => setRepoProvider(v ?? 'github')}>
                  <SelectTrigger id="repo-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">github</SelectItem>
                    <SelectItem value="gitlab">gitlab</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="repo-full">Repository</Label>
                <Input
                  id="repo-full"
                  value={repoFullName}
                  onChange={(e) => setRepoFullName(e.target.value)}
                  placeholder="acme/web"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="repo-branch">Branch</Label>
                <Input
                  id="repo-branch"
                  value={repoBranch}
                  onChange={(e) => setRepoBranch(e.target.value)}
                  placeholder="default branch"
                />
              </div>
              <div className="flex flex-col gap-2 sm:col-span-3">
                <Label htmlFor="repo-setup">Setup script</Label>
                <Textarea
                  id="repo-setup"
                  value={repoSetup}
                  onChange={(e) => setRepoSetup(e.target.value)}
                  placeholder="npm install"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-3">
                <p className="text-xs text-muted-foreground">
                  Cloned into /home/user/&lt;name&gt; in the background; the setup script runs inside the clone.{' '}
                  {env.connections.github.connected ? (
                    'Private GitHub repositories clone through your GitHub App installation.'
                  ) : (
                    <>
                      Private repositories need the{' '}
                      <Link href="/developers/github" className="underline underline-offset-4">
                        GitHub App
                      </Link>{' '}
                      or a GH_TOKEN variable.
                    </>
                  )}{' '}
                  GitLab needs a GITLAB_TOKEN variable.
                </p>
                <Button
                  type="button"
                  disabled={!repoFullName.trim()}
                  onClick={() => {
                    const fullName = repoFullName.trim();
                    const payload: Record<string, unknown> = { provider: repoProvider, repositoryId: fullName, fullName };
                    if (repoBranch.trim()) payload.baseBranch = repoBranch.trim();
                    if (repoSetup.trim()) payload.setupScript = repoSetup;
                    // Clear the inputs only once the save succeeded.
                    void runAction(() => api.addRepo(name, selectedOrgId, payload), 'Could not add repository').then((ok) => {
                      if (!ok) return;
                      setRepoFullName('');
                      setRepoBranch('');
                      setRepoSetup('');
                    });
                  }}
                >
                  Add repository
                </Button>
              </div>
            </div>
            {env.repos.length === 0 ? (
              <EmptyNote title="No repositories." hint="Docks in this environment boot with these cloned." />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Repository</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead>Setup</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {env.repos.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.fullName}</TableCell>
                        <TableCell className="font-mono text-xs">{r.provider}</TableCell>
                        <TableCell className="font-mono text-xs">{r.baseBranch ?? 'default'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.hasSetupScript ? 'script' : '—'}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => runAction(() => api.removeRepo(name, r.id, selectedOrgId), 'Could not remove repository')}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="vars" className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="var-key">Key</Label>
                <Input id="var-key" value={varKey} onChange={(e) => setVarKey(e.target.value)} placeholder="DATABASE_URL" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="var-value">Value</Label>
                <Input
                  id="var-value"
                  type="password"
                  autoComplete="off"
                  value={varValue}
                  onChange={(e) => setVarValue(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  disabled={!varKey.trim()}
                  onClick={() => {
                    const key = varKey.trim();
                    const value = varValue;
                    // Clear the inputs only once the save succeeded.
                    void runAction(() => api.setVar(name, selectedOrgId, key, value), 'Could not set variable').then((ok) => {
                      if (!ok) return;
                      setVarKey('');
                      setVarValue('');
                    });
                  }}
                >
                  Set variable
                </Button>
              </div>
            </div>
            {env.varNames.length === 0 ? (
              <EmptyNote title="No variables." hint="Exported in every dock shell, SSH session, and command." />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {env.varNames.map((key) => (
                      <TableRow key={key}>
                        <TableCell className="font-mono text-sm">{key}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">encrypted</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => runAction(() => api.removeVar(name, key, selectedOrgId), 'Could not remove variable')}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 rounded-md border p-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="file-path">File path</Label>
                <Input
                  id="file-path"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder="web/.env"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="file-contents">Contents</Label>
                <Textarea
                  id="file-contents"
                  value={fileContents}
                  onChange={(e) => setFileContents(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Relative to /home/user. A path inside a repository folder lands in that clone.
                </p>
                <Button
                  type="button"
                  disabled={!filePath.trim()}
                  onClick={() => {
                    const path = filePath.trim();
                    const contents = fileContents;
                    // Clear the inputs only once the save succeeded.
                    void runAction(() => api.setFile(name, selectedOrgId, { path, contents }), 'Could not save file').then((ok) => {
                      if (!ok) return;
                      setFilePath('');
                      setFileContents('');
                    });
                  }}
                >
                  Save file
                </Button>
              </div>
            </div>
            {env.files.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Path</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {env.files.map((f) => (
                      <TableRow key={f.path}>
                        <TableCell className="font-mono text-sm">{f.path}</TableCell>
                        <TableCell className="font-mono text-sm">{formatBytes(f.size)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => runAction(() => api.removeFile(name, f.path, selectedOrgId), 'Could not remove file')}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="settings" className="flex flex-col gap-4">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Pass to docks</h2>
              <div className="flex flex-col divide-y rounded-md border">
                {POSTURE.map((item) => (
                  <div key={item.key} className="flex items-center justify-between gap-4 p-4">
                    <div>
                      <p className="text-sm">{item.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>
                    </div>
                    <Switch
                      aria-label={item.label}
                      checked={env[item.key]}
                      onCheckedChange={(checked) =>
                        runAction(
                          () => api.updateEnvironment(name, selectedOrgId, { [item.key]: checked }),
                          'Could not save setting',
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Secrets access</h2>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
                <div>
                  <p className="text-sm">Who can launch docks with this environment&apos;s secrets</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    With members, any member can create a dock on this environment and read its secrets inside the dock.
                  </p>
                </div>
                {isAdmin ? (
                  <Select
                    value={env.secretsAccess}
                    onValueChange={(v) =>
                      runAction(
                        () => api.updateEnvironment(name, selectedOrgId, { secretsAccess: v }),
                        'Could not save secrets access',
                      )
                    }
                  >
                    <SelectTrigger aria-label="Who can launch docks with this environment's secrets" className="w-40">
                      <SelectValue>{(v: string) => (v === 'admins' ? 'Admins only' : 'Members')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="members">Members</SelectItem>
                      <SelectItem value="admins">Admins only</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">{env.secretsAccess === 'admins' ? 'Admins only' : 'Members'}</Badge>
                )}
              </div>
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Outbound allowlist</h2>
              <div className="flex flex-col gap-3 rounded-md border p-4">
                <p className="text-xs text-muted-foreground">
                  One host per line, like api.github.com or *.npmjs.org (HTTPS only, no IP addresses, at most 50). Empty
                  leaves outbound internet open, as today. With a list, docks on this environment can reach only those
                  hosts, so include what setup needs, such as github.com for cloning and your package registry. Changes
                  apply when a dock is created, resumed or branched on this version; upgrade older docks to pick them up.
                </p>
                <Textarea
                  aria-label="Outbound allowlist"
                  value={egressText ?? (env.egressAllow ?? []).join('\n')}
                  onChange={(e) => setEgressText(e.target.value)}
                  disabled={!isAdmin}
                  placeholder="api.github.com"
                  className="font-mono"
                />
                {isAdmin ? (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      disabled={egressText === null}
                      onClick={() => {
                        const hosts = (egressText ?? '').split('\n').map((h) => h.trim()).filter(Boolean);
                        void runAction(
                          () => api.updateEnvironment(name, selectedOrgId, { egressAllow: hosts.length ? hosts : null }),
                          'Could not save allowlist',
                        ).then((ok) => {
                          if (ok) setEgressText(null);
                        });
                      }}
                    >
                      Save allowlist
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Default</h2>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
                <p className="text-sm text-muted-foreground">
                  {env.isDefault
                    ? 'New docks use this environment unless another is named.'
                    : 'New docks use the default environment unless another is named.'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={env.isDefault}
                  onClick={() =>
                    runAction(() => api.updateEnvironment(name, selectedOrgId, { isDefault: true }), 'Could not set default')
                  }
                >
                  Make default
                </Button>
              </div>
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-destructive">Danger zone</h2>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 p-4">
                <p className="text-sm">
                  Delete this environment. Running docks keep what is on their disks; stopped docks drop it when they
                  resume.
                </p>
                <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </Button>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="versions" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
              <p className="text-sm text-muted-foreground">
                {outdated.length
                  ? `${outdated.reduce((n, v) => n + v.dockCount, 0)} dock(s) run an older version. Upgrading applies v${env.currentVersion} to running docks now and to stopped docks when they resume.`
                  : 'Every dock runs the latest version.'}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={!outdated.length}
                onClick={() =>
                  runAction(
                    () => api.upgradeEnvironment(name, selectedOrgId),
                    'Could not upgrade',
                    `Docks moved to v${env.currentVersion}.`,
                  )
                }
              >
                Upgrade docks to v{env.currentVersion}
              </Button>
            </div>
            {versions === null ? (
              <LoadingRows rows={3} />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Docks</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.map((v) => (
                      <TableRow key={v.version}>
                        <TableCell className="font-mono">v{v.version}</TableCell>
                        <TableCell className="font-mono text-sm">{v.dockCount}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDate(v.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="secrets" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={reveal}>
                Reveal values
              </Button>
              {revealed ? (
                <Button type="button" variant="ghost" onClick={() => setRevealed(null)}>
                  Hide
                </Button>
              ) : null}
              <p className="text-xs text-muted-foreground">Admins only. Values stay in this tab until hidden.</p>
            </div>
            {revealed ? (
              <>
                <pre className="overflow-auto rounded-md border bg-muted/40 p-4 font-mono text-xs">
                  {revealed.envContents || '(no variables)'}
                </pre>
                {revealed.secretFiles.map((f) => (
                  <div key={f.path} className="flex flex-col gap-2">
                    <p className="font-mono text-xs text-muted-foreground">{f.path}</p>
                    <pre className="overflow-auto rounded-md border bg-muted/40 p-4 font-mono text-xs">{f.contents}</pre>
                  </div>
                ))}
              </>
            ) : (
              <EmptyNote title="Encrypted." hint="Values decrypt only here and when a dock boots." />
            )}
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              {env?.isDefault ? 'The oldest other environment becomes the default. ' : ''}This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={remove}>
              Delete environment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function EnvironmentDetailPage() {
  return (
    <Suspense>
      <EnvironmentDetail />
    </Suspense>
  );
}
