import { Injectable } from '@nestjs/common';

/** Open SSH connections per user, so closing or erasing an account can end them; no dependencies, which keeps the gateway and closure service acyclic. */
@Injectable()
export class SshConnectionRegistry {
  private readonly byUser = new Map<string, Set<() => void>>();

  /** Tracks a connection's hang-up; the returned function untracks it. */
  register(userId: string, disconnect: () => void): () => void {
    const set = this.byUser.get(userId) ?? new Set();
    set.add(disconnect);
    this.byUser.set(userId, set);
    return () => {
      set.delete(disconnect);
      if (!set.size && this.byUser.get(userId) === set) this.byUser.delete(userId);
    };
  }

  /** Ends every open connection of the user; returns how many were ended. */
  disconnectUser(userId: string): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    this.byUser.delete(userId);
    for (const disconnect of [...set]) disconnect();
    return set.size;
  }
}
