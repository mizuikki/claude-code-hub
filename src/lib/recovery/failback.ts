import { randomUUID } from "node:crypto";
import type {
  FailbackSkipReason,
  ResolvedSetting,
  SessionFailbackMode,
  SessionFailbackModeOverride,
  SessionFailbackSettings,
} from "./contracts";
import { sessionFailbackBucket } from "./deterministic-bucket";

export interface FailbackBindingSnapshot {
  readonly state: "stable" | "migrating";
  readonly generation: number;
  readonly bindingReason: "initial" | "failover" | "race_winner" | "failback";
  readonly providerId: number;
  readonly effectivePriority: number;
  readonly failedOverFromProviderId: number | null;
  readonly failedOverFromPriority: number | null;
  readonly failedOverAt: number | null;
  readonly failbackCooldownUntil: number | null;
}

export interface FailbackAdmissionInput {
  readonly sessionId: string | null;
  readonly mode: SessionFailbackMode;
  readonly settings: SessionFailbackSettings;
  readonly binding: FailbackBindingSnapshot | null;
  readonly endpointReplayable: boolean;
  readonly requestBlocked: boolean;
  readonly originHealth: "closed" | "open" | "unknown";
  readonly originClosedStableAt: number | null;
  readonly originEligible: boolean;
  readonly originPreferred: boolean;
  readonly originEffectivePriority: number | null;
  readonly now: number;
}

export type FailbackAdmission =
  | { readonly admitted: true; readonly originProviderId: number; readonly cohortBucket: number }
  | { readonly admitted: false; readonly reason: FailbackSkipReason };

export function resolveEffectiveFailbackMode(input: {
  readonly apiKeyOverride: SessionFailbackModeOverride | null | undefined;
  readonly system: ResolvedSetting<SessionFailbackMode>;
}): ResolvedSetting<SessionFailbackMode> {
  if (input.apiKeyOverride && input.apiKeyOverride !== "inherit") {
    return {
      configured: input.apiKeyOverride,
      effective: input.apiKeyOverride,
      source: "api_key",
    };
  }
  return input.system;
}

export function failbackAbortCooldownMs(
  targetDispatched: boolean,
  retryCooldownMs: number
): number {
  return targetDispatched ? retryCooldownMs : 0;
}

export function evaluateFailbackAdmission(input: FailbackAdmissionInput): FailbackAdmission {
  if (!input.sessionId) return { admitted: false, reason: "stateless" };
  if (input.mode === "sticky") return { admitted: false, reason: "sticky_mode" };
  if (
    !input.binding ||
    input.binding.failedOverFromProviderId === null ||
    input.binding.failedOverAt === null
  ) {
    return { admitted: false, reason: "not_failover_binding" };
  }
  if (input.binding.state === "migrating")
    return { admitted: false, reason: "migration_in_progress" };
  if (!input.endpointReplayable) return { admitted: false, reason: "endpoint_not_replayable" };
  if (input.requestBlocked) return { admitted: false, reason: "request_blocked" };
  if (input.originHealth !== "closed") return { admitted: false, reason: "origin_not_closed" };
  if (input.originClosedStableAt === null) return { admitted: false, reason: "origin_not_stable" };
  if (!input.originPreferred) return { admitted: false, reason: "origin_no_longer_preferred" };
  if (!input.originEligible) return { admitted: false, reason: "origin_ineligible" };
  if (
    input.originEffectivePriority === null ||
    input.originEffectivePriority >= input.binding.effectivePriority
  ) {
    return { admitted: false, reason: "origin_not_higher_priority" };
  }
  if (
    input.now <
    Math.max(input.binding.failedOverAt, input.originClosedStableAt) + input.settings.delayMs
  ) {
    return { admitted: false, reason: "delay_not_elapsed" };
  }
  if ((input.binding.failbackCooldownUntil ?? 0) > input.now) {
    return { admitted: false, reason: "cooldown_active" };
  }
  const cohortBucket = sessionFailbackBucket(input.sessionId);
  if (cohortBucket >= Math.round(input.settings.rolloutPercent * 100)) {
    return { admitted: false, reason: "rollout_miss" };
  }
  return {
    admitted: true,
    originProviderId: input.binding.failedOverFromProviderId,
    cohortBucket,
  };
}

export interface FailbackSemaphoreRedis {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const SEMAPHORE_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if ARGV[1] == 'claim' then
  if tonumber(redis.call('ZCARD', KEYS[1])) >= tonumber(ARGV[4]) then return {0, now} end
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
  return {1, now + tonumber(ARGV[3])}
elseif ARGV[1] == 'renew' then
  if not redis.call('ZSCORE', KEYS[1], ARGV[2]) then return {0, now} end
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
  return {1, now + tonumber(ARGV[3])}
elseif ARGV[1] == 'release' then
  redis.call('ZREM', KEYS[1], ARGV[2])
  return {1, now}
end
return {0, now}
`;

export interface FailbackSemaphoreLease {
  readonly token: string;
  readonly expiresAt: number;
}

export class FailbackSemaphore {
  constructor(
    private readonly redis: FailbackSemaphoreRedis,
    private readonly key = "session:failback:migrations"
  ) {}

  private async run(operation: string, token: string, leaseMs: number, capacity: number) {
    const raw = await this.redis.eval(
      SEMAPHORE_LUA,
      1,
      this.key,
      operation,
      token,
      String(leaseMs),
      String(capacity)
    );
    if (!Array.isArray(raw)) throw new TypeError("failback semaphore result must be an array");
    return { applied: Number(raw[0]) === 1, expiresAt: Number(raw[1]) };
  }

  async claim(
    capacity: number,
    leaseMs: number,
    token = randomUUID()
  ): Promise<FailbackSemaphoreLease | null> {
    const result = await this.run("claim", token, leaseMs, capacity);
    return result.applied ? { token, expiresAt: result.expiresAt } : null;
  }

  async renew(
    lease: FailbackSemaphoreLease,
    leaseMs: number
  ): Promise<FailbackSemaphoreLease | null> {
    const result = await this.run("renew", lease.token, leaseMs, 0);
    return result.applied ? { token: lease.token, expiresAt: result.expiresAt } : null;
  }

  async release(lease: FailbackSemaphoreLease): Promise<void> {
    await this.run("release", lease.token, 0, 0);
  }
}
