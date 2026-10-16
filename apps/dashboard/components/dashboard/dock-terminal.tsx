'use client';

import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { terminalSocketUrl, type DockApi } from '@/lib/dock-api';
import { messageOf } from '@/lib/format';
import { EmptyNote } from '@/components/dashboard/data-states';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

// Message kinds: the first byte of every binary frame, shared with the API relay.
const DATA = 0;
const RESIZE = 1;
const EXIT = 2;

type Status = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; message: string; unavailable?: boolean };

function closeMessage(event: CloseEvent, opened: boolean, exitCode: number | null): string {
  if (exitCode !== null) return `Shell exited with code ${exitCode}.`;
  if (event.code === 1006) return opened ? 'Connection lost.' : 'Could not connect to the dock.';
  return event.reason || 'Disconnected.';
}

/** Interactive login shell in a dock, relayed over a ticketed WebSocket. Unmounting hangs the shell up. */
export function DockTerminal({ api, dockId }: { api: DockApi; dockId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [mounted, setMounted] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });

  const send = useCallback((kind: number, payload: Uint8Array) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    ws.send(frame);
  }, []);

  // Detached first, so a replaced socket's late close never overwrites the status.
  const disconnect = useCallback(() => {
    const ws = socket.current;
    socket.current = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.close(1000);
  }, []);

  const connect = useCallback(async () => {
    const terminal = term.current;
    if (!terminal) return;
    disconnect();
    setStatus({ kind: 'connecting' });
    let ticket: string;
    try {
      ticket = (await api.createTerminalTicket(dockId)).ticket;
    } catch (e: unknown) {
      if (term.current === terminal) setStatus({ kind: 'closed', message: messageOf(e, 'Could not open a terminal.'), unavailable: true });
      return;
    }
    if (term.current !== terminal) return;
    const ws = new WebSocket(terminalSocketUrl(dockId, ticket, terminal.cols, terminal.rows));
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    let opened = false;
    let exitCode: number | null = null;
    ws.onopen = () => {
      opened = true;
      setStatus({ kind: 'open' });
      terminal.focus();
    };
    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(event.data);
      if (bytes[0] === DATA) terminal.write(bytes.subarray(1));
      else if (bytes[0] === EXIT && bytes.length === 5) exitCode = new DataView(event.data).getInt32(1);
    };
    ws.onclose = (event) => {
      socket.current = null;
      setStatus({ kind: 'closed', message: closeMessage(event, opened, exitCode) });
    };
  }, [api, dockId, disconnect]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    const encoder = new TextEncoder();
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: getComputedStyle(host).fontFamily,
        fontSize: 13,
        scrollback: 5000,
        theme: { background: '#1c1917', foreground: '#f5f5f4', cursor: '#fdba74', selectionBackground: '#57534e' },
      });
      const fitter = new FitAddon();
      terminal.loadAddon(fitter);
      terminal.open(host);
      terminal.onData((data) => send(DATA, encoder.encode(data)));
      terminal.onBinary((data) => send(DATA, Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
      terminal.onResize(({ cols, rows }) => send(RESIZE, new Uint8Array([cols >> 8, cols & 0xff, rows >> 8, rows & 0xff])));
      // Hidden tabs report zero size; fitting then would collapse the grid.
      observer = new ResizeObserver(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) fitter.fit();
      });
      observer.observe(host);
      if (host.clientWidth > 0) fitter.fit();
      term.current = terminal;
      fit.current = fitter;
      setMounted(true);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      disconnect();
      term.current?.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [send, disconnect]);

  useEffect(() => {
    if (mounted) void connect();
  }, [mounted, connect]);

  const unavailable = status.kind === 'closed' && status.unavailable === true;

  return (
    <div className="flex flex-col gap-2">
      {unavailable ? (
        <div className="flex flex-col items-start gap-3">
          <div className="w-full">
            <EmptyNote title="The terminal is unavailable." hint={status.message} />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void connect()}>
            Retry
          </Button>
        </div>
      ) : null}
      {/* The xterm host stays mounted (hidden) so Retry reuses it. */}
      <div className={unavailable ? 'hidden' : 'flex flex-col gap-2'}>
      <div className="flex min-h-8 flex-wrap items-center gap-3 text-sm">
        <span className="flex flex-1 items-center gap-2 text-muted-foreground" role="status">
          {status.kind === 'connecting' ? (
            <>
              <Spinner /> Connecting…
            </>
          ) : status.kind === 'open' ? (
            <>
              <span className="size-2 rounded-full bg-primary" aria-hidden /> Connected as user
            </>
          ) : (
            status.message
          )}
        </span>
        {status.kind === 'open' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              disconnect();
              setStatus({ kind: 'closed', message: 'Disconnected.' });
            }}
          >
            Disconnect
          </Button>
        ) : status.kind === 'closed' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void connect()} disabled={!mounted}>
            Reconnect
          </Button>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-md bg-[#1c1917] p-2">
        <div ref={container} className="h-[28rem] font-mono" aria-label="Dock terminal" />
      </div>
      <p className="text-xs text-muted-foreground">
        Login shell as the dock user in /home/user/work. Closing this tab hangs the shell up; idle shells close after 30 minutes.
      </p>
      </div>
    </div>
  );
}
