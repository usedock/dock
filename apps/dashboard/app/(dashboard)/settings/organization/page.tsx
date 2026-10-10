'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDefaultApi } from '@/lib/dock-api';
import type { Invitation } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { EmptyNote, ErrorNote, LoadingRows } from '@/components/dashboard/data-states';
import { SettingsSection } from '@/components/dashboard/settings-section';
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Member {
  userId: string;
  email: string;
  role: string;
  createdAt?: string;
}

function inviteState(expiresAt: string): string {
  return new Date(expiresAt).getTime() <= Date.now() ? `Expired ${formatDate(expiresAt)}` : `Expires ${formatDate(expiresAt)}`;
}

const ROLES = [
  { value: 'member', label: 'Member', hint: 'Uses docks, environments, and runs.' },
  { value: 'admin', label: 'Admin', hint: 'Also manages members, keys, and integrations.' },
  { value: 'owner', label: 'Owner', hint: 'Full control, including ownership changes and retention.' },
];

function RoleSelect({ value, onChange, id, label }: { value: string; onChange: (v: string) => void; id?: string; label?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? 'member')}>
      <SelectTrigger id={id} aria-label={label} className="w-32">
        <SelectValue>{ROLES.find((r) => r.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r.value} value={r.value}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Organization membership. Owners manage roles; the last owner stays. */
export default function OrganizationPage() {
  const { selectedOrgId, organizations } = useOrg();
  const [api] = useState(getDefaultApi);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [removing, setRemoving] = useState<Member | null>(null);
  const currentOrg = organizations.find((o) => o.id === selectedOrgId);
  const orgName = currentOrg?.name;
  const isAdmin = currentOrg?.role === 'admin' || currentOrg?.role === 'owner';

  // The scope gate in render covers the unselected case; no sync resets.
  const refresh = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .listMembers(selectedOrgId)
      .then((rows) => {
        setMembers(rows as Member[]);
        setError(null);
      })
      .catch((e: unknown) => {
        setMembers([]);
        setError(messageOf(e, 'Could not load members.'));
      });
    if (!isAdmin) return;
    api
      .listInvitations(selectedOrgId)
      .then((rows) => {
        setInvitations(rows);
        setInvitationsError(null);
      })
      .catch((e: unknown) => {
        setInvitations([]);
        setInvitationsError(messageOf(e, 'Could not load invitations.'));
      });
  }, [api, selectedOrgId, isAdmin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runAction(fn: () => Promise<unknown>, failure: string, success?: string) {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      refresh();
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
    }
  }

  function invite() {
    if (!selectedOrgId || !email.trim()) return;
    const payload = { email: email.trim(), role };
    setEmail('');
    void runAction(() => api.addMember(selectedOrgId, payload), 'Could not invite member', 'Invitation sent if the address can join this organization. They must accept it before getting access.');
  }

  if (!selectedOrgId) return <EmptyNote title="Pick an organization." />;

  return (
    <>
      {actionError ? <ErrorNote message={actionError} /> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

      <SettingsSection
        title="Invite a member"
        description={`Invite someone to ${orgName ?? 'this organization'} by email. They get access after they accept.`}
        footerHint={ROLES.find((r) => r.value === role)?.hint}
        footer={
          <Button type="submit" form="invite-member" size="sm" disabled={!email.trim()}>
            Send invite
          </Button>
        }
      >
        <form
          id="invite-member"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            invite();
          }}
        >
          <div className="flex min-w-64 flex-1 flex-col gap-2">
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="member-role">Role</Label>
            <RoleSelect id="member-role" value={role} onChange={setRole} />
          </div>
        </form>
      </SettingsSection>

      {isAdmin ? (
      <SettingsSection
        title="Pending invitations"
        description="Invitations hold a seat until they are accepted, revoked, or expire."
        flush
      >
        {invitationsError ? (
          <div className="p-5">
            <ErrorNote message={invitationsError} onRetry={refresh} />
          </div>
        ) : invitations === null ? (
          <div className="p-5">
            <LoadingRows rows={2} />
          </div>
        ) : invitations.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No pending invitations.</p>
        ) : (
          <ul className="divide-y">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{inv.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {ROLES.find((r) => r.value === inv.role)?.label ?? inv.role} - {inviteState(inv.expiresAt)}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => runAction(() => api.resendInvitation(selectedOrgId, inv.id), 'Could not resend invitation', 'Invitation resent.')}
                >
                  Resend
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => runAction(() => api.revokeInvitation(selectedOrgId, inv.id), 'Could not revoke invitation')}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      ) : null}

      <SettingsSection
        title="Members"
        description={members && members.length ? `${members.length} ${members.length === 1 ? 'person has' : 'people have'} access.` : undefined}
        flush
      >
        {error ? (
          <div className="p-5">
            <ErrorNote message={error} onRetry={refresh} />
          </div>
        ) : members === null ? (
          <div className="p-5">
            <LoadingRows rows={3} />
          </div>
        ) : members.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="divide-y">
            {members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <Avatar className="size-8">
                  <AvatarFallback className="text-xs">{m.email.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{m.email}</span>
                  <span className="text-xs text-muted-foreground">Joined {formatDate(m.createdAt)}</span>
                </div>
                <RoleSelect
                  label={`Role for ${m.email}`}
                  value={m.role}
                  onChange={(next) => runAction(() => api.updateMemberRole(selectedOrgId, m.userId, next), 'Could not update role')}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(m)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to {orgName ?? 'this organization'} and its docks right away. You can invite them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void runAction(() => api.removeMember(selectedOrgId, target.userId), 'Could not remove member');
              }}
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
