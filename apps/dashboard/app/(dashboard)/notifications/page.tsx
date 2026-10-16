'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleAlert, CreditCard, HardDrive, OctagonX, type LucideIcon } from 'lucide-react';
import { getDefaultApi, type InboxPage, type NotificationItem, type NotificationPreference } from '@/lib/dock-api';
import { formatAgo, formatDate, messageOf } from '@/lib/format';
import { notificationsCopy } from '@/lib/empty-states';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { cn } from '@/lib/utils';
import { useOrg } from '@/components/dashboard/org-context';
import { announceNotificationsChanged } from '@/components/dashboard/app-sidebar';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { SettingsSection } from '@/components/dashboard/settings-section';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const PAGE_SIZE = 25;

/** Alert copy for the inbox and preference rows; types without an entry never fire yet and stay hidden. */
const ALERTS: Record<string, { label: string; detail: string; icon: LucideIcon }> = {
  balance_out: {
    label: 'Balance ran out',
    detail: 'A payment failed, the subscription ended, or spend reached the monthly budget.',
    icon: CreditCard,
  },
  stopped_responding: {
    label: 'Dock stopped responding',
    detail: 'A running dock went missing from its host and was marked as errored.',
    icon: CircleAlert,
  },
  stop_refused: {
    label: 'Dock could not be stopped',
    detail: notificationsCopy(true).stopRefusedDetail,
    icon: OctagonX,
  },
  disk_warning: { label: 'Disk almost full', detail: 'A dock crossed 80% of its disk.', icon: HardDrive },
  disk_full: { label: 'Disk full', detail: 'A dock ran out of disk and its snapshots are failing.', icon: HardDrive },
};

const GROUPS: { audience: NotificationPreference['audience']; title: string; hint: string }[] = [
  { audience: 'billing', title: 'Billing', hint: 'Sent to owners and admins.' },
  { audience: 'dock', title: 'Docks', hint: 'Sent to everyone in the organization.' },
];

/** Human inbox plus org and personal delivery preferences. */
export default function NotificationsPage() {
  const router = useRouter();
  const { organizations, selectedOrgId } = useOrg();
  const [api] = useState(getDefaultApi);
  const [page, setPage] = useState<InboxPage | null>(null);
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [prefs, setPrefs] = useState<NotificationPreference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const billingEnabled = useInstanceConfig()?.billingEnabled !== false;
  const copy = notificationsCopy(billingEnabled);
  const role = organizations.find((o) => o.id === selectedOrgId)?.role;
  const canManageOrg = role === 'owner' || role === 'admin';

  // Settles state only from async continuations; render starts unloaded.
  const loadInbox = useCallback(() => {
    api
      .listInbox(undefined, PAGE_SIZE)
      .then((next) => {
        setPage(next);
        setNow(Date.now());
        setError(null);
      })
      .catch((e: unknown) => setError(messageOf(e, 'Could not load notifications.')));
  }, [api]);

  const loadPrefs = useCallback(() => {
    if (!selectedOrgId) return;
    api
      .getNotificationPreferences(selectedOrgId)
      .then((rows) => {
        setPrefs(rows);
        setPrefsError(null);
      })
      .catch((e: unknown) => setPrefsError(messageOf(e, 'Could not load preferences.')));
  }, [api, selectedOrgId]);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  async function loadMore() {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await api.listInbox(page.nextCursor, PAGE_SIZE);
      setPage({ ...next, notifications: [...page.notifications, ...next.notifications] });
    } catch (e: unknown) {
      setActionError(`Could not load more: ${messageOf(e, 'request failed')}`);
    } finally {
      setLoadingMore(false);
    }
  }

  function markLocal(ids: Set<string> | 'all') {
    setPage((prev) => {
      if (!prev) return prev;
      let cleared = 0;
      const notifications = prev.notifications.map((n) => {
        if (n.read || (ids !== 'all' && !ids.has(n.id))) return n;
        cleared += 1;
        return { ...n, read: true };
      });
      const unreadCount = ids === 'all' ? 0 : Math.max(0, prev.unreadCount - cleared);
      return { ...prev, notifications, unreadCount };
    });
  }

  async function markRead(item: NotificationItem) {
    if (item.read) return;
    setActionError(null);
    try {
      await api.markNotificationRead(item.id);
      markLocal(new Set([item.id]));
      announceNotificationsChanged();
    } catch (e: unknown) {
      setActionError(`Could not mark read: ${messageOf(e, 'request failed')}`);
    }
  }

  async function markAllRead() {
    setActionError(null);
    try {
      await api.markAllNotificationsRead();
      markLocal('all');
      announceNotificationsChanged();
    } catch (e: unknown) {
      setActionError(`Could not mark all read: ${messageOf(e, 'request failed')}`);
    }
  }

  function open(item: NotificationItem) {
    void markRead(item);
    router.push(item.linkPath);
  }

  async function setPref(type: string, patch: Partial<Pick<NotificationPreference, 'enabled' | 'emailEnabled'>>) {
    if (!selectedOrgId || !prefs) return;
    const before = prefs;
    setActionError(null);
    setPrefs(prefs.map((p) => (p.type === type ? { ...p, ...patch } : p)));
    try {
      if (patch.enabled !== undefined) await api.updateOrgNotificationPreference(selectedOrgId, type, patch.enabled);
      if (patch.emailEnabled !== undefined) await api.updatePersonalNotificationPreference(type, patch.emailEnabled);
    } catch (e: unknown) {
      setPrefs(before);
      setActionError(`Could not save preference: ${messageOf(e, 'request failed')}`);
    }
  }

  const unread = page?.unreadCount ?? 0;
  const rows = (page?.notifications ?? []).filter((n) => tab === 'all' || !n.read);
  const visiblePrefs = (prefs ?? []).filter((p) => ALERTS[p.type] && (billingEnabled || p.audience !== 'billing'));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Notifications"
        description={copy.subtitle}
        action={
          unread > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void markAllRead()}>
              Mark all read
            </Button>
          ) : null
        }
      />
      {actionError ? <ErrorNote message={actionError} /> : null}

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'unread')}>
        <TabsList aria-label="Inbox filter">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unread">
            Unread
            {unread > 0 ? <span className="ml-1 font-mono text-xs tabular-nums text-primary">{unread}</span> : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {error ? (
        <ErrorNote message={error} onRetry={loadInbox} />
      ) : page === null ? (
        <LoadingRows rows={3} />
      ) : rows.length === 0 ? (
        tab === 'unread' && page.notifications.length > 0 ? (
          <EmptyNote title="All caught up." hint="Nothing unread. Earlier alerts are under All." />
        ) : (
          <EmptyNote title="No notifications yet." hint={copy.emptyHint} />
        )
      ) : (
        <div className="rounded-md border">
          <ul className="divide-y">
            {rows.map((item) => {
              const Icon = ALERTS[item.type]?.icon ?? CircleAlert;
              return (
                <li key={item.id} className={cn('flex items-start gap-3 px-4 py-3', !item.read && 'bg-primary/[0.03]')}>
                  <span
                    aria-hidden
                    className={cn('mt-2 size-1.5 shrink-0 rounded-full', item.read ? 'bg-transparent' : 'bg-primary')}
                  />
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Link
                        href={item.linkPath}
                        onClick={(e) => {
                          e.preventDefault();
                          open(item);
                        }}
                        className={cn('text-sm underline-offset-4 hover:underline', !item.read && 'font-medium')}
                      >
                        {item.title}
                      </Link>
                      {!item.read ? <span className="sr-only">Unread</span> : null}
                      <time
                        dateTime={item.occurredAt}
                        title={formatDate(item.occurredAt)}
                        className="text-xs text-muted-foreground tabular-nums"
                      >
                        {formatAgo(item.occurredAt, now)}
                      </time>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.body}</p>
                  </div>
                  {!item.read ? (
                    <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => void markRead(item)}>
                      Mark read
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {page.nextCursor ? (
            <div className="border-t px-4 py-2">
              <Button type="button" variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load older'}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <SettingsSection
        title="Delivery"
        description="Every alert lands in this inbox. Organization switches decide whether an alert is sent at all; email switches are yours alone."
        footerHint={canManageOrg ? 'Organization switches apply to every member.' : 'Only owners and admins can change organization switches.'}
        flush
      >
        {!selectedOrgId ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Pick an organization to manage its alerts.</p>
        ) : prefsError ? (
          <div className="p-4">
            <ErrorNote message={prefsError} onRetry={loadPrefs} />
          </div>
        ) : prefs === null ? (
          <div className="p-4">
            <LoadingRows rows={3} />
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[1fr_5.5rem_4.5rem] items-center gap-4 border-b px-5 py-2 text-xs text-muted-foreground">
              <span>Alert</span>
              <span>Organization</span>
              <span>Email</span>
            </div>
            {GROUPS.map((group) => {
              const items = visiblePrefs.filter((p) => p.audience === group.audience);
              if (items.length === 0) return null;
              return (
                <div key={group.audience}>
                  <div className="flex items-baseline gap-2 border-b bg-muted/40 px-5 py-2">
                    <span className="text-xs font-medium">{group.title}</span>
                    <span className="text-xs text-muted-foreground">{group.hint}</span>
                  </div>
                  <ul className="divide-y border-b last:border-b-0">
                    {items.map((pref) => {
                      const alert = ALERTS[pref.type];
                      return (
                        <li key={pref.type} className="grid grid-cols-[1fr_5.5rem_4.5rem] items-center gap-4 px-5 py-3">
                          <div className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">{alert.label}</span>
                            <span className="text-sm text-muted-foreground">
                              {pref.type === 'stop_refused' ? copy.stopRefusedDetail : alert.detail}
                            </span>
                          </div>
                          <Switch
                            aria-label={`Send ${alert.label} alerts for this organization`}
                            checked={pref.enabled}
                            disabled={!canManageOrg}
                            onCheckedChange={(checked) => void setPref(pref.type, { enabled: checked })}
                          />
                          <Switch
                            aria-label={`Email me ${alert.label} alerts`}
                            checked={pref.enabled && pref.emailEnabled}
                            disabled={!pref.enabled}
                            onCheckedChange={(checked) => void setPref(pref.type, { emailEnabled: checked })}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
