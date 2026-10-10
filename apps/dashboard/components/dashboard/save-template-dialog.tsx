'use client';

import { useState, type FormEvent } from 'react';
import type { Dock, DockApi, Template } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ErrorNote } from './data-states';

// Mirrors the backend TEMPLATE_RE so bad names never leave the form.
const NAME_RE = /^[a-z0-9]([a-z0-9-_]{1,63}[a-z0-9])$/;

/** Saves a dock's current state under a name; re-using a name repoints it. */
export function SaveTemplateDialog({
  api,
  docks,
  open,
  onOpenChange,
  onSaved,
}: {
  api: DockApi;
  docks: Dock[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (template: Template) => void;
}) {
  const [dockId, setDockId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = docks.find((d) => d.id === dockId) ?? docks[0];
  const trimmed = name.trim();
  const valid = NAME_RE.test(trimmed);
  const stopped = selected?.state === 'archived';

  function close(next: boolean) {
    if (busy) return;
    if (!next) {
      setName('');
      setError(null);
    }
    onOpenChange(next);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selected || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveTemplate(selected.id, trimmed);
      setName('');
      onOpenChange(false);
      onSaved(saved);
    } catch (err: unknown) {
      setError(messageOf(err, 'Could not save template.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Save template</DialogTitle>
            <DialogDescription>
              Freezes a dock&apos;s filesystem under a name. New docks can start from it; saving an existing name
              replaces it without touching docks already deployed.
            </DialogDescription>
          </DialogHeader>
          {docks.length > 1 ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="template-dock">Dock</Label>
              <NativeSelect id="template-dock" className="w-full" value={selected?.id ?? ''} onChange={(e) => setDockId(e.target.value)}>
                {docks.map((d) => (
                  <NativeSelectOption key={d.id} value={d.id}>
                    {d.name} ({d.state === 'archived' ? 'stopped' : d.state})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="template-name">Name</Label>
            <Input
              id="template-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="web-stack"
              autoComplete="off"
              aria-invalid={trimmed !== '' && !valid}
              aria-describedby="template-name-hint"
            />
            <p id="template-name-hint" className="text-xs text-muted-foreground">
              2-64 lowercase letters, digits, dashes, or underscores.
            </p>
          </div>
          {selected ? (
            <p className="text-sm text-muted-foreground">
              {stopped
                ? `${selected.name} is stopped, so its latest snapshot is used.`
                : `${selected.name} is captured as it is right now.`}
              {selected.runtime === 'gvisor' ? ' gVisor docks keep /home/user/work only.' : null}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Create a dock first; templates are saved from docks.</p>
          )}
          {error ? <ErrorNote message={error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!selected || !valid || busy}>
              {busy ? 'Saving…' : 'Save template'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
