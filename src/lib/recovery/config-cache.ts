import { getEnvConfig } from "@/lib/config/env.schema";
import {
  getPersistedRecoveryConfiguration,
  type PersistedRecoveryConfiguration,
} from "@/repository/recovery-config";
import {
  type ResolvedRecoveryConfiguration,
  recoveryStartupSettingsFromEnv,
  resolveRecoveryConfiguration,
} from "./config";

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: Promise<ResolvedRecoveryConfiguration>;
}

const cache = new Map<number | "system", CacheEntry>();

function resolvePersisted(
  persisted: PersistedRecoveryConfiguration
): ResolvedRecoveryConfiguration {
  return resolveRecoveryConfiguration({
    providerRecovery: persisted.provider?.recoverySettings,
    providerProbeBudgets: persisted.provider?.recoveryProbeBudgets,
    systemRecovery: persisted.system.recoverySettings,
    systemProbeBudgets: persisted.system.recoveryProbeBudgets,
    systemFailback: persisted.system.sessionFailbackSettings,
    startup: recoveryStartupSettingsFromEnv(getEnvConfig()),
  });
}

export async function getCachedRecoveryConfiguration(
  providerId?: number
): Promise<ResolvedRecoveryConfiguration> {
  const key = providerId ?? "system";
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;

  const value = getPersistedRecoveryConfiguration(providerId).then(resolvePersisted);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  try {
    return await value;
  } catch (error) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  }
}

export function invalidateRecoveryConfiguration(providerId?: number): void {
  if (providerId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(providerId);
}
