'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { API_BASE_URL, type DockApi, type SnapshotFile } from '@/lib/dock-api';
import { formatBytes, messageOf } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyNote, ErrorNote, LoadingRows } from './data-states';

const SHOWN = 500;

/** Read-only listing of one snapshot's files, each downloadable on its own. */
export function SnapshotFilesDialog({
  api,
  snapshotId,
  onOpenChange,
}: {
  api: DockApi;
  snapshotId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [files, setFiles] = useState<SnapshotFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Resets during render for a new target, then loads in the effect; closing keeps the last listing.
  if (snapshotId && snapshotId !== loadedFor) {
    setLoadedFor(snapshotId);
    setFiles(null);
    setError(null);
    setFilter('');
  }

  useEffect(() => {
    if (!snapshotId) return;
    let live = true;
    api
      .snapshotTree(snapshotId)
      .then((tree) => live && setFiles(tree.files ?? []))
      .catch((e: unknown) => {
        if (!live) return;
        setFiles([]);
        setError(messageOf(e, 'Could not list snapshot files.'));
      });
    return () => {
      live = false;
    };
  }, [api, snapshotId]);

  const needle = filter.trim().toLowerCase();
  const matched = (files ?? []).filter((f) => !needle || f.path.toLowerCase().includes(needle));

  return (
    <Dialog open={snapshotId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Snapshot files</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{loadedFor?.slice(0, 8)}</span>
            {files ? ` · ${files.length} ${files.length === 1 ? 'file' : 'files'}` : null}
          </DialogDescription>
        </DialogHeader>
        {error ? <ErrorNote message={error} /> : null}
        {files === null ? (
          <LoadingRows rows={4} />
        ) : files.length === 0 ? (
          error ? null : <EmptyNote title="This snapshot has no files." />
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by path"
              aria-label="Filter files by path"
            />
            <div className="max-h-96 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Path</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Download</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matched.slice(0, SHOWN).map((f) => (
                    <TableRow key={f.path}>
                      <TableCell className="max-w-0 truncate font-mono text-xs" title={f.path}>
                        {f.path}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs whitespace-nowrap">{formatBytes(f.size)}</TableCell>
                      <TableCell className="p-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          nativeButton={false}
                          aria-label={`Download ${f.path}`}
                          render={
                            <a
                              href={`${API_BASE_URL}/v1/snapshots/${encodeURIComponent(loadedFor ?? '')}/files?path=${encodeURIComponent(f.path)}`}
                              download={f.path.split('/').pop()}
                            />
                          }
                        >
                          <Download />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {matched.length > SHOWN ? (
              <p className="text-xs text-muted-foreground">
                Showing {SHOWN} of {matched.length}. Filter to narrow the list.
              </p>
            ) : matched.length === 0 ? (
              <p className="text-xs text-muted-foreground">No paths match.</p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
