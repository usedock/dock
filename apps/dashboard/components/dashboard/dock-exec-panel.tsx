'use client';

import { useState } from 'react';
import type { DockApi, DockExecResult } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { ErrorNote } from '@/components/dashboard/data-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

function Stream({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
        {text || <span className="text-muted-foreground">(empty)</span>}
      </pre>
    </div>
  );
}

/** Runs one command through POST /v1/docks/:id/exec; disabled with a reason when the dock cannot take one. */
export function DockExecPanel({ api, dockId, disabledReason }: { api: DockApi; dockId: string; disabledReason: string | null }) {
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DockExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.execDock(dockId, { command }));
    } catch (e: unknown) {
      setResult(null);
      setError(messageOf(e, 'Command failed to run.'));
    } finally {
      setRunning(false);
    }
  }

  const disabled = disabledReason !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="exec-command">Run command</Label>
        <Textarea
          id="exec-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && command.trim() && !disabled && !running) run();
          }}
          placeholder="ls -la"
          disabled={disabled}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          {disabledReason ?? 'Runs as the dock user with bash -lc in /home/user/work. 60s timeout; output keeps its first 1 MiB.'}
        </p>
      </div>
      <div>
        <Button type="button" onClick={run} disabled={disabled || running || !command.trim()}>
          {running ? <Spinner /> : null}
          Run
        </Button>
      </div>
      {error ? <ErrorNote message={error} /> : null}
      {result ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={result.exitCode === 0 ? 'secondary' : 'destructive'}>exit {result.exitCode}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{result.durationMs} ms</span>
            {result.truncated ? <Badge variant="outline">truncated</Badge> : null}
          </div>
          <Stream label="stdout" text={result.stdout} />
          <Stream label="stderr" text={result.stderr} />
        </div>
      ) : null}
    </div>
  );
}
