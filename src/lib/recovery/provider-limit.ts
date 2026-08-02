import { createHash } from "node:crypto";
import type { ProviderLimitScope } from "./contracts";

export function credentialFingerprint(credential: string): string {
  if (!credential) throw new TypeError("credential must be non-empty");
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function providerLimitKey(scope: ProviderLimitScope): string {
  if (!Number.isSafeInteger(scope.providerId) || scope.providerId <= 0) {
    throw new RangeError("providerId must be a positive safe integer");
  }
  if (!/^[a-f0-9]{64}$/.test(scope.credentialFingerprint)) {
    throw new TypeError("credentialFingerprint must be a lowercase SHA-256 digest");
  }
  return `cb:v2:provider_limit:{${scope.providerId}:${scope.credentialFingerprint}}`;
}

export interface ProviderLimitRedis {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const SET_COOLDOWN_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local requested_until = now + tonumber(ARGV[1])
local current_until = tonumber(redis.call('HGET', KEYS[1], 'blocked_until') or '0')
local blocked_until = math.max(current_until, requested_until)
redis.call('HSET', KEYS[1], 'blocked_until', blocked_until, 'reason', ARGV[2], 'updated_at', now)
redis.call('PEXPIRE', KEYS[1], math.max(1000, blocked_until - now + tonumber(ARGV[3])))
return {blocked_until, now}
`;

const READ_COOLDOWN_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local blocked_until = tonumber(redis.call('HGET', KEYS[1], 'blocked_until') or '0')
if blocked_until <= now then
  redis.call('DEL', KEYS[1])
  return {0, now}
end
return {blocked_until, now}
`;

function numericPair(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new TypeError("provider-limit Lua result must be a numeric pair");
  }
  return [Number(value[0]), Number(value[1])];
}

export class ProviderLimitService {
  constructor(
    private readonly redis: ProviderLimitRedis,
    private readonly retentionMarginMs = 60_000
  ) {}

  async applyCooldown(input: {
    scope: ProviderLimitScope;
    retryAfterMs: number;
    reason: string;
  }): Promise<{ blockedUntil: number; redisTimeMs: number }> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 200) throw new TypeError("cooldown reason must be bounded");
    const [blockedUntil, redisTimeMs] = numericPair(
      await this.redis.eval(
        SET_COOLDOWN_LUA,
        1,
        providerLimitKey(input.scope),
        String(Math.max(0, Math.trunc(input.retryAfterMs))),
        reason,
        String(this.retentionMarginMs)
      )
    );
    return { blockedUntil, redisTimeMs };
  }

  async getCooldown(
    scope: ProviderLimitScope
  ): Promise<{ blocked: boolean; blockedUntil: number | null; redisTimeMs: number }> {
    const [blockedUntil, redisTimeMs] = numericPair(
      await this.redis.eval(READ_COOLDOWN_LUA, 1, providerLimitKey(scope))
    );
    return {
      blocked: blockedUntil > redisTimeMs,
      blockedUntil: blockedUntil > redisTimeMs ? blockedUntil : null,
      redisTimeMs,
    };
  }
}
