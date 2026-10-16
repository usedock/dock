'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  Cable,
  Camera,
  Container,
  CreditCard,
  GitBranch,
  KeyRound,
  KeySquare,
  Layers,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Webhook,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { getDefaultApi, type Dock } from '@/lib/dock-api';
import { useOrg } from '@/components/dashboard/org-context';
import { dockSearchValue, paletteDocks, shortDockId, workspaceDocks } from '@/lib/palette-docks';
import { useInstanceConfig, withoutBillingWhenDisabled } from '@/lib/use-instance-config';

const DESTINATIONS = [
  { href: '/docks', label: 'Docks', icon: Container },
  { href: '/snapshots', label: 'Snapshots & Templates', icon: Camera },
  { href: '/environments', label: 'Environments', icon: Layers },
  { href: '/runs', label: 'Runs', icon: GitBranch },
  { href: '/connectors', label: 'Connectors', icon: Cable },
  { href: '/billing', label: 'Billing', icon: CreditCard },
  { href: '/developers/webhooks', label: 'Webhooks', icon: Webhook },
  { href: '/developers/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/developers/ssh-keys', label: 'SSH keys', icon: KeySquare },
  { href: '/developers/provider-keys', label: 'Provider keys', icon: ShieldCheck },
  { href: '/developers/github', label: 'GitHub App', icon: Plug },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const PaletteContext = createContext<{ setOpen: (open: boolean) => void } | null>(null);

/** Hosts the cmd/ctrl+K palette and its open state for the whole dashboard shell. */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { selectedWorkspaceId } = useOrg();
  const [open, setOpen] = useState(false);
  const [docks, setDocks] = useState<Dock[]>([]);
  const [search, setSearch] = useState('');
  const destinations = withoutBillingWhenDisabled(DESTINATIONS, useInstanceConfig());

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setSearch('');
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Fetched on open; failures just leave the group empty.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getDefaultApi()
      .listDocks(undefined, true)
      .then((rows) => {
        if (!cancelled) setDocks(workspaceDocks(rows, selectedWorkspaceId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, selectedWorkspaceId]);

  function changeOpen(next: boolean) {
    setOpen(next);
    setSearch('');
  }

  function go(href: string) {
    changeOpen(false);
    router.push(href);
  }

  const value = useMemo(() => ({ setOpen }), []);

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={changeOpen}
        title="Command palette"
        description="Jump anywhere or start a new dock"
      >
        <Command>
          <CommandInput placeholder="Jump to… or create a dock" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem value="new dock create" onSelect={() => go('/docks?new=1')}>
                <Plus />
                New dock
                <CommandShortcut>N</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            {docks.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Docks">
                  {paletteDocks(docks, search).map((dock) => (
                    <CommandItem key={dock.id} value={dockSearchValue(dock)} onSelect={() => go(`/docks/${dock.id}`)}>
                      <Container />
                      <span className="truncate">{dock.name}</span>
                      <CommandShortcut>{shortDockId(dock.id)}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            <CommandSeparator />
            <CommandGroup heading="Go to">
              {destinations.map((item) => (
                <CommandItem key={item.href} value={item.label} onSelect={() => go(item.href)}>
                  <item.icon />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </PaletteContext.Provider>
  );
}

/** Header button that opens the palette; shows the keyboard hint on desktop. */
export function CommandPaletteTrigger() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('CommandPaletteTrigger must be used within CommandPaletteProvider.');
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => ctx.setOpen(true)}
      className="gap-2 text-muted-foreground"
    >
      <Search />
      <span className="hidden sm:inline">Search</span>
      <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
    </Button>
  );
}
