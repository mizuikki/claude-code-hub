import type { RecoveryHealth, RecoveryScope } from "./contracts";
import { hashRecoveryScope } from "./scope";

export type LocalRecoveryHealth = RecoveryHealth | "unknown";

interface CacheEntry {
  readonly health: RecoveryHealth;
  readonly epoch: number;
  readonly cachedAt: number;
}

export class RecoveryStrictnessCache {
  private readonly entries = new Map<string, CacheEntry>();

  putAuthoritative(
    scope: RecoveryScope,
    health: RecoveryHealth,
    epoch: number,
    cachedAt = Date.now()
  ) {
    const key = hashRecoveryScope(scope);
    const current = this.entries.get(key);
    if (current && epoch < current.epoch) return false;
    this.entries.set(key, { health, epoch, cachedAt });
    return true;
  }

  markOpen(scope: RecoveryScope, epoch: number, cachedAt = Date.now()): boolean {
    const key = hashRecoveryScope(scope);
    const current = this.entries.get(key);
    if (current && epoch < current.epoch) return false;
    this.entries.set(key, {
      health: "open",
      epoch: Math.max(epoch, current?.epoch ?? epoch),
      cachedAt,
    });
    return true;
  }

  get(scope: RecoveryScope): CacheEntry | null {
    return this.entries.get(hashRecoveryScope(scope)) ?? null;
  }

  canRouteWhileDegraded(scope: RecoveryScope, degradedSince: number): boolean {
    const entry = this.get(scope);
    return Boolean(entry && entry.health === "closed" && entry.cachedAt <= degradedSince);
  }

  clear(): void {
    this.entries.clear();
  }
}
