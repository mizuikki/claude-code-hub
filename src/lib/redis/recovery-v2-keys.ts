import type { RecoveryScope } from "@/lib/recovery/contracts";
import { hashRecoveryScope } from "@/lib/recovery/scope";

export type RecoveryKeyNamespace = "production" | "shadow";

export interface RecoveryScopeKeys {
  readonly scopeHash: string;
  readonly state: string;
  readonly trials: string;
  readonly outcomes: string;
  readonly window: string;
}

export function recoveryScopeKeys(
  scope: RecoveryScope,
  namespace: RecoveryKeyNamespace = "production"
): RecoveryScopeKeys {
  const scopeHash = hashRecoveryScope(scope);
  const prefix = namespace === "shadow" ? "cb:shadow:v2" : "cb:v2";
  const base = `${prefix}:{${scopeHash}}`;
  return {
    scopeHash,
    state: `${base}:state`,
    trials: `${base}:trials`,
    outcomes: `${base}:outcomes`,
    window: `${base}:window`,
  };
}

export function recoveryDueKey(namespace: RecoveryKeyNamespace = "production"): string {
  return namespace === "shadow" ? "cb:shadow:v2:recovery_due" : "cb:v2:recovery_due";
}

export function recoveryRedisHashTag(key: string): string | null {
  const start = key.indexOf("{");
  if (start < 0) return null;
  const end = key.indexOf("}", start + 1);
  return end > start + 1 ? key.slice(start + 1, end) : null;
}

export function redisClusterSlot(key: string): number {
  const input = new TextEncoder().encode(recoveryRedisHashTag(key) ?? key);
  let crc = 0;
  for (const byte of input) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16_384;
}
