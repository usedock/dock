'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDefaultApi } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { ErrorNote, LoadingRows } from '@/components/dashboard/data-states';
import { SettingsSection } from '@/components/dashboard/settings-section';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Profile {
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  email?: string | null;
}

const BIO_MAX = 280;

function initials(name: string, email: string | null | undefined): string {
  const source = name.trim() || email || '?';
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

/** Personal profile: display name, avatar, bio. */
export default function ProfilePage() {
  const [api] = useState(getDefaultApi);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [bio, setBio] = useState('');

  // Settles state only from async continuations; render starts unloaded.
  const refresh = useCallback(() => {
    api
      .getProfile()
      .then((p) => {
        const row = p as Profile;
        setProfile(row);
        setDisplayName(row.displayName ?? '');
        setAvatarUrl(row.avatarUrl ?? '');
        setBio(row.bio ?? '');
        setError(null);
      })
      .catch((e: unknown) => setError(messageOf(e, 'Could not load profile.')));
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function save() {
    setActionError(null);
    setSaved(false);
    setSaving(true);
    try {
      await api.updateProfile({
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(avatarUrl.trim() ? { avatarUrl: avatarUrl.trim() } : {}),
        ...(bio ? { bio } : {}),
      });
      setSaved(true);
      refresh();
    } catch (e: unknown) {
      setActionError(`Could not save profile: ${messageOf(e, 'request failed')}`);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorNote message={error} onRetry={refresh} />;
  if (!profile) return <LoadingRows rows={3} />;

  const dirty =
    displayName !== (profile.displayName ?? '') || avatarUrl !== (profile.avatarUrl ?? '') || bio !== (profile.bio ?? '');

  return (
    <SettingsSection
      title="Profile"
      description="How you appear to teammates in your organizations."
      footerHint={saved && !dirty ? 'Saved.' : 'Changes apply everywhere you appear.'}
      footer={
        <Button type="button" size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {actionError ? <ErrorNote message={actionError} /> : null}
        <div className="flex items-center gap-4">
          <Avatar className="size-12">
            {avatarUrl.trim() ? <AvatarImage src={avatarUrl.trim()} alt="" /> : null}
            <AvatarFallback>{initials(displayName, profile.email)}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{displayName.trim() || 'No display name'}</span>
            {profile.email ? <span className="text-sm text-muted-foreground">{profile.email}</span> : null}
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="profile-name">Display name</Label>
            <Input id="profile-name" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="profile-avatar">Avatar URL</Label>
            <Input
              id="profile-avatar"
              inputMode="url"
              placeholder="https://…"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="profile-bio">Bio</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {bio.length}/{BIO_MAX}
            </span>
          </div>
          <Textarea id="profile-bio" rows={3} maxLength={BIO_MAX} value={bio} onChange={(e) => setBio(e.target.value)} />
        </div>
      </div>
    </SettingsSection>
  );
}
