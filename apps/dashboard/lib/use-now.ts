'use client';

import { useEffect, useState } from 'react';

type VisibilityTarget = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

/**
 * Calls `onTick` every `intervalMs` while the document is visible, and once
 * immediately when it becomes visible again. Returns a stop function.
 */
export function startTicker(doc: VisibilityTarget, intervalMs: number, onTick: () => void): () => void {
  const timer = setInterval(() => {
    if (!doc.hidden) onTick();
  }, intervalMs);
  const onVisibility = () => {
    if (!doc.hidden) onTick();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Current time in ms, refreshed every `intervalMs` so "x ago" labels stay live. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startTicker(document, intervalMs, () => setNow(Date.now())), [intervalMs]);
  return now;
}
