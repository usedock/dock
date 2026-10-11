import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

export const PORT_AUTH_CACHE_TTL_MS = 5_000;
export const PORT_AUTH_CACHE_MAX = 10_000;

interface Entry {
  label: string;
  dockId: string;
  expires: number;
}

/** Short-lived memory of granted private-port decisions, keyed by label and credential hash; denials are never stored. */
@Injectable()
export class PortAuthCache {
  private readonly entries = new Map<string, Entry>();

  /** Plain fields so specs can shrink them. */
  ttlMs = PORT_AUTH_CACHE_TTL_MS;
  max = PORT_AUTH_CACHE_MAX;

  private key(label: string, credential: string): string {
    return `${label}:${createHash('sha256').update(credential).digest('base64url')}`;
  }

  /** True while a grant for this credential on this dock's port is fresh. */
  has(label: string, credential: string, dockId: string, now = Date.now()): boolean {
    const key = this.key(label, credential);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expires <= now || entry.dockId !== dockId) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  grant(label: string, credential: string, dockId: string, now = Date.now()): void {
    const key = this.key(label, credential);
    this.entries.delete(key);
    if (this.entries.size >= this.max) this.makeRoom(now);
    this.entries.set(key, { label, dockId, expires: now + this.ttlMs });
  }

  /** Forgets every grant for a port label (visibility change or removal). */
  invalidateLabel(label: string): void {
    for (const [key, entry] of this.entries) if (entry.label === label) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Sweeps expired entries; when none are, drops the oldest. */
  private makeRoom(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    if (this.entries.size < this.max) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
