'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDefaultApi } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { isAccountClosed, visibleAccountActions, type AccountAction } from '@/lib/empty-states';
import { useOrg } from '@/components/dashboard/org-context';
import { ErrorNote, LoadingRows } from '@/components/dashboard/data-states';
import { SettingsSection } from '@/components/dashboard/settings-section';
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
import { Switch } from '@/components/ui/switch';

const RETENTION_PHRASE = 'delete archived dock data';
// Must match ERASE_CONFIRM_PHRASE in the backend account-closure service.
const ERASE_PHRASE = 'erase my account data';

const ACCOUNT_ACTIONS: { id: AccountAction; title: string; detail: string; button: string; destructive: boolean }[] = [
  {
    id: 'close',
    title: 'Close account',
    detail: 'Stops your docks and revokes your keys. Your data is kept, so you can reopen later.',
    button: 'Close account…',
    destructive: true,
  },
  { id: 'reopen', title: 'Reopen account', detail: 'Restores a closed account with its data.', button: 'Reopen…', destructive: false },
  {
    id: 'erase',
    title: 'Erase account',
    detail: 'Permanently deletes your docks, snapshots, templates, keys, and profile.',
    button: 'Erase account…',
    destructive: true,
  },
];

/** Safety: the org's zero-data-retention switch plus whole-account close/reopen/erase. */
export default function SafetyPage() {
  const { selectedOrgId } = useOrg();
  const [api] = useState(getDefaultApi);
  const [retention, setRetention] = useState<{ enabled?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingRetention, setConfirmingRetention] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [pendingAction, setPendingAction] = useState<AccountAction | null>(null);
  const [erasePhrase, setErasePhrase] = useState('');
  const [working, setWorking] = useState(false);
  const [closed, setClosed] = useState(false);

  // The scope gate in render covers the unselected case; no sync resets.
  const refresh = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .getRetention(selectedOrgId)
      .then((r) => {
        setRetention(r as { enabled?: boolean });
        setError(null);
      })
      .catch((e: unknown) => {
        setRetention(null);
        setError(messageOf(e, 'Could not load retention policy.'));
      });
  }, [api, selectedOrgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Closed accounts are refused on /v1/me, which is how the page learns the state.
  useEffect(() => {
    api.getMe().catch((e: unknown) => setClosed(isAccountClosed(e)));
  }, [api]);

  async function setRetentionEnabled(enabled: boolean) {
    if (!selectedOrgId) return;
    setActionError(null);
    setWorking(true);
    try {
      await api.updateRetention(selectedOrgId, enabled, enabled ? RETENTION_PHRASE : '');
      setConfirmingRetention(false);
      setPhrase('');
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not update retention: ${messageOf(e, 'request failed')}`);
    } finally {
      setWorking(false);
    }
  }

  async function runAccountAction() {
    if (!pendingAction) return;
    setWorking(true);
    setActionError(null);
    try {
      if (pendingAction === 'close') {
        await api.closeAccount();
        setClosed(true);
      }
      if (pendingAction === 'reopen') {
        await api.reopenAccount();
        setClosed(false);
      }
      if (pendingAction === 'erase') await api.eraseAccount(ERASE_PHRASE);
      setPendingAction(null);
    } catch (e: unknown) {
      setActionError(`Account action failed: ${messageOf(e, 'request failed')}`);
    } finally {
      setWorking(false);
    }
  }

  const action = ACCOUNT_ACTIONS.find((a) => a.id === pendingAction);

  return (
    <>
      {actionError ? <ErrorNote message={actionError} /> : null}

      <SettingsSection
        title="Zero data retention"
        description="When on, Dock keeps nothing from stopped docks for this organization: stopped docks and every template are deleted, and templates stay off."
        footerHint="Owners only, from a browser session."
      >
        {!selectedOrgId ? (
          <p className="text-sm text-muted-foreground">Pick an organization to manage its retention.</p>
        ) : error ? (
          <ErrorNote message={error} onRetry={refresh} />
        ) : retention === null ? (
          <LoadingRows rows={1} />
        ) : (
          <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium">{retention.enabled ? 'On' : 'Off'}</span>
              <span className="text-sm text-muted-foreground">
                {retention.enabled
                  ? 'Stopped dock data is deleted and templates are disabled.'
                  : 'Stopped docks and templates are kept until you delete them.'}
              </span>
            </div>
            <Switch
              aria-label="Zero data retention"
              checked={!!retention.enabled}
              disabled={working}
              onCheckedChange={(checked) => (checked ? setConfirmingRetention(true) : void setRetentionEnabled(false))}
            />
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Account" description="These apply to your whole account, across every organization." danger flush>
        <ul className="divide-y divide-destructive/20">
          {ACCOUNT_ACTIONS.filter((a) => visibleAccountActions(closed).includes(a.id)).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{a.title}</span>
                <span className="text-sm text-muted-foreground">{a.detail}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant={a.destructive ? 'destructive' : 'outline'}
                onClick={() => {
                  setErasePhrase('');
                  setPendingAction(a.id);
                }}
              >
                {a.button}
              </Button>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <Dialog open={confirmingRetention} onOpenChange={(open) => !open && setConfirmingRetention(false)}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (phrase === RETENTION_PHRASE) void setRetentionEnabled(true);
            }}
          >
            <DialogHeader>
              <DialogTitle>Turn on zero data retention?</DialogTitle>
              <DialogDescription>
                Stopped docks and all templates in this organization are deleted now and cannot be recovered.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="retention-phrase">
                Type <span className="font-mono">{RETENTION_PHRASE}</span> to confirm
              </Label>
              <Input id="retention-phrase" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmingRetention(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={phrase !== RETENTION_PHRASE || working}>
                {working ? 'Deleting…' : 'Delete and turn on'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => !open && setPendingAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action?.title}?</DialogTitle>
            <DialogDescription>
              {action?.detail} {pendingAction === 'erase' ? 'This cannot be undone.' : ''}
            </DialogDescription>
          </DialogHeader>
          {pendingAction === 'erase' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="erase-phrase">
                Type <span className="font-mono">{ERASE_PHRASE}</span> to confirm
              </Label>
              <Input id="erase-phrase" autoComplete="off" value={erasePhrase} onChange={(e) => setErasePhrase(e.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={action?.destructive ? 'destructive' : 'default'}
              disabled={working || (pendingAction === 'erase' && erasePhrase !== ERASE_PHRASE)}
              onClick={runAccountAction}
            >
              {working ? 'Working…' : action?.title}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
