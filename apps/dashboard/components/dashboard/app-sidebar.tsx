'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  Bell,
  BookOpen,
  Camera,
  ChevronsUpDown,
  Container,
  CreditCard,
  GitBranch,
  KeyRound,
  KeySquare,
  Layers,
  Plug,
  Server,
  Settings,
  ShieldCheck,
  Webhook,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { Logo } from '@/components/logo';
import { getDefaultApi } from '@/lib/dock-api';
import { useInstanceConfig, withoutBillingWhenDisabled } from '@/lib/use-instance-config';
import { useOrg } from './org-context';

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.usedock.io';

const PRIMARY = [
  { href: '/docks', label: 'Docks', icon: Container },
  { href: '/snapshots', label: 'Snapshots & Templates', icon: Camera },
  { href: '/environments', label: 'Environments', icon: Layers },
  { href: '/runs', label: 'Runs', icon: GitBranch },
  { href: '/billing', label: 'Billing', icon: CreditCard },
];

const DEVELOPERS = [
  { href: '/developers/webhooks', label: 'Webhooks', icon: Webhook },
  { href: '/developers/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/developers/ssh-keys', label: 'SSH keys', icon: KeySquare },
  { href: '/developers/provider-keys', label: 'Provider keys', icon: ShieldCheck },
  { href: '/developers/github', label: 'GitHub App', icon: Plug },
];

const INSTANCE = [{ href: '/hosts', label: 'Hosts', icon: Server }];

const PERSONAL = [
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const NOTIFICATIONS_CHANGED = 'dock:notifications-changed';
const UNREAD_POLL_MS = 60_000;

/** Tells the sidebar to re-read the unread count after the inbox changes. */
export function announceNotificationsChanged() {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

function NavItems({
  items,
  pathname,
  badges = {},
}: {
  items: typeof PRIMARY;
  pathname: string;
  badges?: Record<string, number>;
}) {
  return (
    <>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton render={<Link href={item.href} />} isActive={active} tooltip={item.label}>
              <item.icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
            {badges[item.href] ? (
              <SidebarMenuBadge className="text-primary" aria-label={`${badges[item.href]} unread`}>
                {badges[item.href] > 99 ? '99+' : badges[item.href]}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        );
      })}
    </>
  );
}

/** Single persistent shell for every authenticated dashboard route. */
export function AppSidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const { organizations, workspaces, selectedOrgId, selectedWorkspaceId, selectOrg, selectWorkspace } = useOrg();
  const selectedOrg = organizations.find((o) => o.id === selectedOrgId) ?? null;
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const primary = withoutBillingWhenDisabled(PRIMARY, useInstanceConfig());
  const [instanceAdmin, setInstanceAdmin] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    getDefaultApi()
      .getMe()
      .then((me) => setInstanceAdmin(me.instanceAdmin === true))
      .catch(() => setInstanceAdmin(false));
  }, []);

  useEffect(() => {
    const load = () =>
      getDefaultApi()
        .listInbox(undefined, 1)
        .then((page) => setUnread(page.unreadCount))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, UNREAD_POLL_MS);
    window.addEventListener(NOTIFICATIONS_CHANGED, load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, load);
    };
  }, []);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-2">
        <Link href="/docks" className="flex items-center gap-2 px-2 py-1 outline-none group-data-[collapsible=icon]:px-1 focus-visible:ring-2 focus-visible:ring-ring">
          <Logo className="text-foreground [&_span:last-child]:text-base group-data-[collapsible=icon]:[&_span:last-child]:hidden" />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Select organization"
                className="flex w-full group-data-[collapsible=icon]:hidden items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <span className="flex flex-1 items-center gap-2 truncate">
              <span className="flex-1 truncate">{selectedOrg?.name ?? 'No organization'}</span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {organizations.length === 0 ? (
              <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
            ) : (
              organizations.map((org) => (
                <DropdownMenuItem key={org.id} onClick={() => selectOrg(org.id)}>
                  <span className="flex-1 truncate">{org.name}</span>
                  {org.role ? <span className="text-xs text-muted-foreground">{org.role}</span> : null}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {workspaces.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Select workspace"
                  className="flex w-full group-data-[collapsible=icon]:hidden items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <span className="flex flex-1 items-center gap-2 truncate">
                <span className="flex-1 truncate font-mono">{selectedWorkspace?.name ?? 'No workspace'}</span>
                <ChevronsUpDown className="size-3.5 shrink-0" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {workspaces.map((ws) => (
                <DropdownMenuItem key={ws.id} onClick={() => selectWorkspace(ws.id)}>
                  <span className="flex-1 truncate">{ws.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/settings/workspaces" />}>Manage workspaces</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItems items={primary} pathname={pathname} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Developers</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItems items={DEVELOPERS} pathname={pathname} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {instanceAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel>Instance</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItems items={INSTANCE} pathname={pathname} />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItems items={PERSONAL} pathname={pathname} badges={{ '/notifications': unread }} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />} tooltip="Docs">
              <BookOpen />
              <span>Docs</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm group-data-[collapsible=icon]:hidden">
              <span className="flex-1 truncate text-muted-foreground">{userEmail}</span>
              <SignOutButton />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
