'use client';

import { useEffect, useState } from 'react';

export type VisibilityTarget = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

/** Ticks every `intervalMs` while visible, and once on becoming visible; returns a stop function. */
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
