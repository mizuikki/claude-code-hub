import { z } from "zod";
import type { EnvConfig } from "@/lib/config/env.schema";
import type {
  RecoveryAuthorityMode,
  RecoveryProbeBudgetOverrides,
  RecoveryProbeBudgets,
  RecoverySettings,
  RecoverySettingsOverrides,
  ResolvedSetting,
  SessionBindingAuthorityMode,
  SessionFailbackSettings,
  SessionFailbackSettingsOverrides,
} from "./contracts";
import { resolveRecoverySetting } from "./policy";

const nullablePositiveInteger = z.number().int().positive().nullable().optional();
const nullableRate = z.number().min(0).max(1).nullable().optional();

export const RecoverySettingsOverridesSchema = z
  .object({
    openDurationMs: nullablePositiveInteger,
    windowDurationMs: nullablePositiveInteger,
    bucketDurationMs: nullablePositiveInteger,
    minimumRealOutcomes: nullablePositiveInteger,
    failureThreshold: nullablePositiveInteger,
    maximumFailureRate: nullableRate,
    slowCallDurationMs: nullablePositiveInteger,
    maximumSlowCallRate: nullableRate,
    consecutiveHard5xxThreshold: nullablePositiveInteger,
    rampDurationMs: nullablePositiveInteger,
    stableDurationMs: nullablePositiveInteger,
    halfOpenMaxConcurrency: nullablePositiveInteger,
    halfOpenSuccessThreshold: nullablePositiveInteger,
    stateRetentionMs: nullablePositiveInteger,
    passiveHalfOpenEnabled: z.boolean().nullable().optional(),
    recoveryTrafficEnabled: z.boolean().nullable().optional(),
    activeProbesEnabled: z.boolean().nullable().optional(),
  })
  .strict();

export const RecoveryProbeBudgetOverridesSchema = z
  .object({
    safeModel: z.string().trim().min(1).max(200).nullable().optional(),
    globalConcurrency: nullablePositiveInteger,
    providerConcurrency: nullablePositiveInteger,
    requestsPerMinute: nullablePositiveInteger,
    maxTokensPerProbe: nullablePositiveInteger,
    timeoutMs: nullablePositiveInteger,
    dailyCostUsd: z.number().positive().nullable().optional(),
  })
  .strict();

export const SessionFailbackSettingsOverridesSchema = z
  .object({
    mode: z.enum(["sticky", "safe_auto"]).nullable().optional(),
    delayMs: z.number().int().nonnegative().nullable().optional(),
    retryCooldownMs: z.number().int().nonnegative().nullable().optional(),
    rolloutPercent: z.number().int().min(0).max(100).nullable().optional(),
    maxConcurrentMigrations: nullablePositiveInteger,
    migrationWaitMs: z.number().int().min(1).max(10_000).nullable().optional(),
  })
  .strict();

export const CODE_RECOVERY_DEFAULTS: RecoverySettings = Object.freeze({
  openDurationMs: 1_800_000,
  windowDurationMs: 60_000,
  bucketDurationMs: 10_000,
  minimumRealOutcomes: 5,
  failureThreshold: 5,
  maximumFailureRate: 0.05,
  slowCallDurationMs: null,
  maximumSlowCallRate: 0.1,
  consecutiveHard5xxThreshold: 3,
  rampDurationMs: 300_000,
  stableDurationMs: 60_000,
  halfOpenMaxConcurrency: 1,
  halfOpenSuccessThreshold: 2,
  stateRetentionMs: 86_400_000,
  passiveHalfOpenEnabled: false,
  recoveryTrafficEnabled: false,
  activeProbesEnabled: false,
});

export const CODE_PROBE_BUDGET_DEFAULTS: RecoveryProbeBudgets = Object.freeze({
  safeModel: null,
  globalConcurrency: 1,
  providerConcurrency: 1,
  requestsPerMinute: 6,
  maxTokensPerProbe: 32,
  timeoutMs: 10_000,
  dailyCostUsd: 1,
});

export const CODE_FAILBACK_DEFAULTS: SessionFailbackSettings = Object.freeze({
  mode: "sticky",
  delayMs: 300_000,
  retryCooldownMs: 600_000,
  rolloutPercent: 100,
  maxConcurrentMigrations: 1,
  migrationWaitMs: 100,
});

export interface RecoveryStartupSettings {
  readonly recoveryAuthorityMode: RecoveryAuthorityMode;
  readonly sessionBindingAuthorityMode: SessionBindingAuthorityMode;
  readonly recovery: RecoverySettingsOverrides;
  readonly probeBudgets: RecoveryProbeBudgetOverrides;
  readonly failback: SessionFailbackSettingsOverrides;
}

export function recoveryStartupSettingsFromEnv(env: EnvConfig): RecoveryStartupSettings {
  return {
    recoveryAuthorityMode: env.RECOVERY_AUTHORITY_MODE ?? "legacy",
    sessionBindingAuthorityMode: env.SESSION_BINDING_AUTHORITY_MODE ?? "legacy",
    recovery: {
      openDurationMs: env.RECOVERY_OPEN_DURATION_MS ?? null,
      windowDurationMs: env.RECOVERY_WINDOW_DURATION_MS ?? null,
      bucketDurationMs: env.RECOVERY_BUCKET_DURATION_MS ?? null,
      minimumRealOutcomes: env.RECOVERY_MINIMUM_REAL_OUTCOMES ?? null,
      failureThreshold: env.RECOVERY_FAILURE_THRESHOLD ?? null,
      maximumFailureRate: env.RECOVERY_MAXIMUM_FAILURE_RATE ?? null,
      slowCallDurationMs: env.RECOVERY_SLOW_CALL_DURATION_MS ?? null,
      maximumSlowCallRate: env.RECOVERY_MAXIMUM_SLOW_CALL_RATE ?? null,
      consecutiveHard5xxThreshold: env.RECOVERY_CONSECUTIVE_HARD_5XX_THRESHOLD ?? null,
      rampDurationMs: env.RECOVERY_RAMP_DURATION_MS ?? null,
      stableDurationMs: env.RECOVERY_STABLE_DURATION_MS ?? null,
      halfOpenMaxConcurrency: env.RECOVERY_HALF_OPEN_MAX_CONCURRENCY ?? null,
      halfOpenSuccessThreshold: env.RECOVERY_HALF_OPEN_SUCCESS_THRESHOLD ?? null,
      stateRetentionMs: env.RECOVERY_STATE_RETENTION_MS ?? null,
      passiveHalfOpenEnabled: env.RECOVERY_PASSIVE_HALF_OPEN_ENABLED ?? null,
      recoveryTrafficEnabled: env.RECOVERY_TRAFFIC_ENABLED ?? null,
      activeProbesEnabled: env.RECOVERY_ACTIVE_PROBES_ENABLED ?? env.ENABLE_SMART_PROBING ?? null,
    },
    probeBudgets: {
      safeModel: env.RECOVERY_PROBE_SAFE_MODEL ?? null,
      globalConcurrency: env.RECOVERY_PROBE_GLOBAL_CONCURRENCY ?? null,
      providerConcurrency: env.RECOVERY_PROBE_PROVIDER_CONCURRENCY ?? null,
      requestsPerMinute: env.RECOVERY_PROBE_REQUESTS_PER_MINUTE ?? null,
      maxTokensPerProbe: env.RECOVERY_PROBE_MAX_TOKENS ?? null,
      timeoutMs: env.RECOVERY_PROBE_TIMEOUT_MS ?? null,
      dailyCostUsd: env.RECOVERY_PROBE_DAILY_COST_USD ?? null,
    },
    failback: {
      mode: env.SESSION_FAILBACK_MODE ?? null,
      delayMs: env.SESSION_FAILBACK_DELAY_MS ?? null,
      retryCooldownMs: env.SESSION_FAILBACK_RETRY_COOLDOWN_MS ?? null,
      rolloutPercent: env.SESSION_FAILBACK_ROLLOUT_PERCENT ?? null,
      maxConcurrentMigrations: env.SESSION_FAILBACK_MAX_CONCURRENT_MIGRATIONS ?? null,
      migrationWaitMs: env.SESSION_FAILBACK_MIGRATION_WAIT_MS ?? null,
    },
  };
}

type ResolvedObject<T> = { readonly [Key in keyof T]: ResolvedSetting<T[Key]> };

function resolvedObject<T extends object>(
  provider: Partial<{ [Key in keyof T]: T[Key] | null }>,
  system: Partial<{ [Key in keyof T]: T[Key] | null }>,
  environment: Partial<{ [Key in keyof T]: T[Key] | null }>,
  code: T
): ResolvedObject<T> {
  const result = {} as { [Key in keyof T]: ResolvedSetting<T[Key]> };
  for (const key of Object.keys(code) as Array<keyof T>) {
    result[key] = resolveRecoverySetting({
      provider: provider[key] ?? null,
      system: system[key] ?? null,
      environment: environment[key] ?? null,
      code: code[key],
    });
  }
  return result;
}

export interface ResolvedRecoveryConfiguration {
  readonly recovery: ResolvedObject<RecoverySettings>;
  readonly probeBudgets: ResolvedObject<RecoveryProbeBudgets>;
  readonly failback: ResolvedObject<SessionFailbackSettings>;
}

export function resolveRecoveryConfiguration(input: {
  readonly providerRecovery?: RecoverySettingsOverrides | null;
  readonly providerProbeBudgets?: RecoveryProbeBudgetOverrides | null;
  readonly systemRecovery?: RecoverySettingsOverrides | null;
  readonly systemProbeBudgets?: RecoveryProbeBudgetOverrides | null;
  readonly systemFailback?: SessionFailbackSettingsOverrides | null;
  readonly startup: RecoveryStartupSettings;
}): ResolvedRecoveryConfiguration {
  const result = {
    recovery: resolvedObject(
      input.providerRecovery ?? {},
      input.systemRecovery ?? {},
      input.startup.recovery,
      CODE_RECOVERY_DEFAULTS
    ),
    probeBudgets: resolvedObject(
      input.providerProbeBudgets ?? {},
      input.systemProbeBudgets ?? {},
      input.startup.probeBudgets,
      CODE_PROBE_BUDGET_DEFAULTS
    ),
    failback: resolvedObject(
      {},
      input.systemFailback ?? {},
      input.startup.failback,
      CODE_FAILBACK_DEFAULTS
    ),
  };

  validateEffectiveRecoverySettings(
    Object.fromEntries(
      Object.entries(result.recovery).map(([key, setting]) => [key, setting.effective])
    ) as unknown as RecoverySettings
  );
  return result;
}

export function validateEffectiveRecoverySettings(settings: RecoverySettings): void {
  RecoverySettingsOverridesSchema.parse(settings);
  if (settings.windowDurationMs % settings.bucketDurationMs !== 0) {
    throw new RangeError("recovery window duration must be divisible by bucket duration");
  }
  if (settings.bucketDurationMs > settings.windowDurationMs) {
    throw new RangeError("recovery bucket duration cannot exceed window duration");
  }
  if (settings.halfOpenSuccessThreshold < settings.halfOpenMaxConcurrency) {
    throw new RangeError("half-open success threshold cannot be below maximum concurrency");
  }
  const requiredRetention =
    settings.openDurationMs + settings.rampDurationMs + settings.stableDurationMs;
  if (settings.stateRetentionMs < requiredRetention) {
    throw new RangeError("recovery state retention is shorter than the recovery lifecycle");
  }
}
