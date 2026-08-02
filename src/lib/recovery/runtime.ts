import { randomUUID } from "node:crypto";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { RateLimitService } from "@/lib/rate-limit";
import { getRedisClient } from "@/lib/redis/client";
import { RecoveryV2Service } from "@/lib/redis/recovery-v2-service";
import { SessionBindingV2Service } from "@/lib/redis/session-binding-v2-service";
import {
  getPersistedRecoveryConfiguration,
  listPendingDegradedOpenEvidence,
  markDegradedOpenEvidenceReconciled,
  upsertDegradedOpenEvidence,
} from "@/repository/recovery-config";
import { recordRecoveryProbeUsage } from "@/repository/recovery-probe-ledger";
import { AttemptOutcomeFinalizer } from "./attempt-finalizer";
import { importLegacyHealth, legacyRollbackTarget } from "./authority";
import { setSessionBindingRuntime } from "./binding-authority";
import {
  RecoveryCompatibilityFacade,
  setRecoveryCompatibilityFacade,
} from "./compatibility-facade";
import type { CompositeLease } from "./composite-admission";
import { claimCompositeHalfOpen, evaluateCompositeScopes } from "./composite-admission";
import { getCachedRecoveryConfiguration } from "./config-cache";
import type {
  AttemptIdentity,
  RecoveryEffect,
  RecoveryProbeBudgets,
  RecoveryScope,
  RecoverySettings,
  ResolvedSetting,
  RetrySafety,
} from "./contracts";
import { RecoveryDegradationGate, RecoveryDegradedReconciler } from "./degradation";
import {
  notificationClassForTransition,
  RecoveryNotificationDeduplicator,
  RecoveryNotificationDispatcher,
  type RecoveryNotificationRedis,
  recoveryMetrics,
  recoveryTransitionLog,
} from "./observability";
import {
  type DueSchedulerRedis,
  deterministicProbeBackoffMs,
  parseCanonicalRecoveryScope,
  RecoveryDueScheduler,
} from "./probe-scheduler";
import { ProviderLimitService } from "./provider-limit";
import {
  effectiveRecoveryBasisPoints,
  setProviderRecoveryEvaluator,
  setProviderRecoveryShadowObserver,
  setProviderRecoveryValidator,
} from "./routing-admission";
import { hashRecoveryScope } from "./scope";
import { RecoveryStrictnessCache } from "./strictness-cache";

type ResolvedSettings = {
  readonly [Key in keyof RecoverySettings]: ResolvedSetting<RecoverySettings[Key]>;
};
let productionRecoveryService: RecoveryV2Service | null = null;
let shadowRecoveryService: RecoveryV2Service | null = null;
let dueSchedulerInterval: NodeJS.Timeout | null = null;
let activeRecoveryMode: "legacy" | "shadow" | "enforce" = "legacy";
let providerLimitService: ProviderLimitService | null = null;
let activeDegradedReconciler: RecoveryDegradedReconciler | null = null;
let recoveryNotificationDispatcher: RecoveryNotificationDispatcher | null = null;
const redisWithRecoveryListeners = new WeakSet<object>();
const activeHalfOpenLeases = new Map<
  string,
  { readonly leases: readonly CompositeLease[]; readonly createdAt: number }
>();
const activeAttemptFinalizers = new Map<
  string,
  { finalizer: AttemptOutcomeFinalizer; owner: symbol; touchedAt: number }
>();
const strictnessCache = new RecoveryStrictnessCache();
const degradationGate = new RecoveryDegradationGate(
  strictnessCache,
  { upsert: upsertDegradedOpenEvidence },
  randomUUID()
);

export function recoveryRuntimeIsDegraded(): boolean {
  return degradationGate.degraded;
}

export function getRecoveryAuthorityMode(): "legacy" | "shadow" | "enforce" {
  return activeRecoveryMode;
}

export function getRecoveryProviderLimitService(): ProviderLimitService | null {
  return providerLimitService;
}

export async function prepareCompositeRecoveryAttempt(input: {
  scopes: readonly RecoveryScope[];
  identity: AttemptIdentity;
  leaseMs: number;
  recoveryBucket: number | null;
}): Promise<boolean> {
  if (activeRecoveryMode !== "enforce" || !productionRecoveryService) return true;
  try {
    for (const scope of input.scopes) {
      let snapshot = await productionRecoveryService.getState(scope);
      if (!snapshot) {
        await productionRecoveryService.initializeScope(scope, "closed");
        snapshot = await productionRecoveryService.getState(scope);
      }
      if (snapshot) {
        strictnessCache.putAuthoritative(scope, snapshot.health, snapshot.epoch);
        if (snapshot.health === "recovering") {
          if (input.recoveryBucket === null) return false;
          const validation = await productionRecoveryService.validateRecoveryAdmission({
            scope,
            expectedEpoch: snapshot.epoch,
            expectedStageIndex: snapshot.recoveryStageIndex,
            bucket: input.recoveryBucket,
          });
          if (validation.code !== "applied") return false;
        }
      }
    }
    if (
      (await evaluateCompositeScopes(productionRecoveryService, input.scopes)).code === "blocked"
    ) {
      return false;
    }
  } catch {
    degradationGate.enter();
    return input.scopes.every((scope) => degradationGate.mayRouteStateless(scope));
  }
  let claimed;
  try {
    claimed = await claimCompositeHalfOpen({
      service: productionRecoveryService,
      scopes: input.scopes,
      identity: input.identity,
      leaseMs: input.leaseMs,
      maximumLeaseMs: 10 * 60_000,
    });
  } catch {
    degradationGate.enter();
    return false;
  }
  if (claimed.code === "applied" && claimed.leases.length > 0) {
    const now = Date.now();
    if (activeHalfOpenLeases.size >= 10_000) {
      for (const [attemptId, entry] of activeHalfOpenLeases) {
        if (now - entry.createdAt > 10 * 60_000) activeHalfOpenLeases.delete(attemptId);
      }
    }
    activeHalfOpenLeases.set(input.identity.attemptOutcomeId, {
      leases: claimed.leases,
      createdAt: now,
    });
    for (const lease of claimed.leases) {
      recoveryMetrics.add("recovery.half_open_inflight", 1, {
        scope_kind: lease.scope.kind,
      });
      recoveryMetrics.add("recovery.half_open_trials", 1, {
        scope_kind: lease.scope.kind,
        result: "claimed",
      });
    }
  }
  return claimed.code === "applied";
}

export async function finalizeRecoveryAttempt(input: {
  identity: AttemptIdentity;
  effects: readonly RecoveryEffect[];
  retrySafety: RetrySafety;
  upstreamCommitted: boolean;
  downstreamCommitted: boolean;
  durationMs: number;
}): Promise<void> {
  const recoveryService =
    activeRecoveryMode === "shadow" ? shadowRecoveryService : productionRecoveryService;
  if (activeRecoveryMode === "legacy" || !recoveryService || input.effects.length === 0) return;
  let settled;
  try {
    const before = await Promise.all(
      input.effects.map((effect) => recoveryService.getState(effect.scope))
    );
    const halfOpen = activeHalfOpenLeases.get(input.identity.attemptOutcomeId);
    if (halfOpen) {
      try {
        for (const lease of halfOpen.leases) {
          const effect = input.effects.find(
            (candidate) => hashRecoveryScope(candidate.scope) === hashRecoveryScope(lease.scope)
          );
          try {
            const result = await recoveryService.completeHalfOpenTrial({
              lease,
              disposition: effect?.disposition ?? "ignored",
              durationMs: input.durationMs,
            });
            if (result.code !== "applied" && result.code !== "duplicate") {
              throw new Error(`half-open outcome rejected: ${result.code}`);
            }
            recoveryMetrics.add("recovery.half_open_trials", 1, {
              scope_kind: lease.scope.kind,
              result: effect?.disposition ?? "ignored",
            });
          } finally {
            recoveryMetrics.add("recovery.half_open_inflight", -1, {
              scope_kind: lease.scope.kind,
            });
          }
        }
      } finally {
        activeHalfOpenLeases.delete(input.identity.attemptOutcomeId);
      }
    }
    const attemptId = input.identity.attemptOutcomeId;
    let finalizerEntry = activeAttemptFinalizers.get(attemptId);
    if (!finalizerEntry) {
      if (activeAttemptFinalizers.size >= 10_000) {
        const now = Date.now();
        for (const [id, entry] of activeAttemptFinalizers) {
          if (now - entry.touchedAt > 10 * 60_000) activeAttemptFinalizers.delete(id);
        }
      }
      const finalizer = new AttemptOutcomeFinalizer(
        { ...input, providerLimit: null },
        recoveryService,
        null
      );
      finalizerEntry = {
        finalizer,
        owner: finalizer.claimOwner(),
        touchedAt: Date.now(),
      };
      activeAttemptFinalizers.set(attemptId, finalizerEntry);
    }
    finalizerEntry.touchedAt = Date.now();
    const finalization = await finalizerEntry.finalizer.finalize(finalizerEntry.owner);
    const after = await Promise.all(
      input.effects.map((effect) => recoveryService.getState(effect.scope))
    );
    settled = { before, after, finalization };
  } catch (error) {
    degradationGate.enter();
    for (const effect of input.effects) {
      if (effect.disposition !== "transient_failure" && effect.disposition !== "hard_failure") {
        continue;
      }
      try {
        await degradationGate.observeLocalOpen(effect.scope, effect.reason);
      } catch (evidenceError) {
        logger.error("Recovery degraded evidence persistence failed", {
          error: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
        });
      }
    }
    logger.error("Recovery attempt finalization entered degraded mode", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (let index = 0; index < input.effects.length; index += 1) {
    const effect = input.effects[index];
    const previous = settled.before[index];
    const current = settled.after[index];
    recoveryMetrics.add("recovery.attempts", 1, {
      scope_kind: effect.scope.kind,
      result: effect.disposition,
      authority: activeRecoveryMode,
    });
    if (settled.finalization.status === "duplicate") {
      recoveryMetrics.add("recovery.duplicate_outcomes", 1, { scope_kind: effect.scope.kind });
    }
    if (!previous || !current || previous.health === current.health) continue;
    const reasonClass =
      effect.reason.startsWith("admin") || effect.reason.startsWith("force_")
        ? "admin"
        : effect.reason.includes("probe")
          ? "probe"
          : effect.reason.includes("transport") || effect.reason.includes("timeout")
            ? "transport"
            : effect.reason.includes("upstream")
              ? "upstream"
              : "classified_outcome";
    logger.info(
      "Recovery state transition",
      recoveryTransitionLog({
        scope: effect.scope,
        from: previous.health,
        to: current.health,
        epoch: current.epoch,
        reasonClass,
      })
    );
    recoveryMetrics.add("recovery.transitions", 1, {
      scope_kind: effect.scope.kind,
      from_state: previous.health,
      to_state: current.health,
      reason_class: reasonClass,
    });
    recoveryMetrics.add("recovery.state", 1, {
      scope_kind: effect.scope.kind,
      to_state: current.health,
    });
    if (
      current.health === "open" &&
      (previous.health === "recovering" || previous.health === "half_open")
    ) {
      recoveryMetrics.add("recovery.reopens", 1, {
        scope_kind: effect.scope.kind,
        reason_class: reasonClass,
      });
    }
    await recoveryNotificationDispatcher?.dispatch({
      scope: effect.scope,
      scopeHash: hashRecoveryScope(effect.scope),
      state: current.health,
      epoch: current.epoch,
      notificationClass: notificationClassForTransition({
        from: previous.health,
        to: current.health,
        automationPaused: current.automationPaused,
        reasonClass,
      }),
    });
  }
}

async function accountRecoveryProbe(
  input: Parameters<typeof recordRecoveryProbeUsage>[0]
): Promise<void> {
  await recordRecoveryProbeUsage(input);
  recoveryMetrics.add("recovery.probes", 1, {
    scope_kind: input.scope.kind,
    result: input.succeeded ? "success" : "failure",
  });
  recoveryMetrics.add("recovery.probe_duration", input.durationMs, {
    scope_kind: input.scope.kind,
    result: input.succeeded ? "success" : "failure",
  });
  recoveryMetrics.add("recovery.probe_tokens", input.inputTokens + input.outputTokens, {
    scope_kind: input.scope.kind,
    result: input.costUsd === null ? "unknown_cost" : "priced",
  });
  recoveryMetrics.add("recovery.probe_cost", input.costUsd ?? 0, {
    scope_kind: input.scope.kind,
    result: input.costUsd === null ? "unknown" : "known",
  });
  if (!input.succeeded) {
    const service =
      activeRecoveryMode === "shadow" ? shadowRecoveryService : productionRecoveryService;
    const state = await service?.getState(input.scope);
    if (state) {
      await recoveryNotificationDispatcher?.dispatch({
        scope: input.scope,
        scopeHash: hashRecoveryScope(input.scope),
        state: state.health,
        epoch: state.epoch,
        notificationClass: "active_probe_failed",
      });
    }
  }
  if (input.costUsd === null || input.scope.kind === "vendor-type") return;
  const { findProviderById } = await import("@/repository/provider");
  const provider = await findProviderById(input.scope.providerId);
  if (!provider) return;
  await RateLimitService.trackProviderRecoveryProbeCost(provider.id, input.costUsd, {
    provider5hResetMode: provider.limit5hResetMode,
    providerResetTime: provider.dailyResetTime,
    providerResetMode: provider.dailyResetMode,
  });
}

async function calculateRecoveryProbeCost(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  multiplier: number;
}): Promise<number | null> {
  const [{ findLatestPriceByModel }, { calculateRequestCost }] = await Promise.all([
    import("@/repository/model-price"),
    import("@/lib/utils/cost-calculation"),
  ]);
  const price = await findLatestPriceByModel(input.model);
  if (!price) return null;
  return calculateRequestCost(
    { input_tokens: input.inputTokens, output_tokens: input.outputTokens },
    price.priceData,
    input.multiplier
  ).toNumber();
}

export function getProductionRecoveryService(): RecoveryV2Service | null {
  return productionRecoveryService;
}

export function getRecoveryManagementService(): RecoveryV2Service | null {
  return activeRecoveryMode === "shadow" ? shadowRecoveryService : productionRecoveryService;
}

/**
 * Compatibility circuit resets restart validation instead of force-closing a V2 scope.
 * Legacy and shadow authorities keep their existing compatibility behavior.
 */
export async function restartRecoveryValidation(input: {
  readonly scope: RecoveryScope;
  readonly expectedEpoch?: number;
  readonly reason?: string;
}): Promise<
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly result: { readonly code: string; readonly epoch: number; readonly health: string };
    }
> {
  if (activeRecoveryMode !== "enforce" || !productionRecoveryService) {
    return { handled: false };
  }
  const reason = input.reason?.trim() || "compatibility_reset";
  const state = await productionRecoveryService.getState(input.scope);
  if (!state) {
    const initialized = await productionRecoveryService.initializeScope(input.scope, "open");
    return { handled: true, result: initialized };
  }
  if (input.expectedEpoch !== undefined && input.expectedEpoch !== state.epoch) {
    return {
      handled: true,
      result: { code: "stale_epoch", epoch: state.epoch, health: state.health },
    };
  }
  return {
    handled: true,
    result: await productionRecoveryService.administrate({
      scope: input.scope,
      action: "reset",
      expectedEpoch: state.epoch,
      reason,
    }),
  };
}

export async function runRecoveryProbe(
  scope: import("./contracts").RecoveryScope,
  expectedEpoch: number
): Promise<{ code: string; epoch: number; health: string }> {
  if (activeRecoveryMode === "shadow") {
    return { code: "shadow_probe_disabled", epoch: expectedEpoch, health: "open" };
  }
  const service = productionRecoveryService;
  if (!service) return { code: "unavailable", epoch: expectedEpoch, health: "unknown" };
  if (scope.kind === "vendor-type") {
    return { code: "unsupported_scope", epoch: expectedEpoch, health: "open" };
  }
  const resolved = await getCachedRecoveryConfiguration(scope.providerId);
  const budgets = effectiveProbeBudgets(resolved.probeBudgets);
  if (!budgets.safeModel)
    return { code: "safe_model_required", epoch: expectedEpoch, health: "open" };
  const claimed = await service.claimProbe({
    scope,
    expectedEpoch,
    leaseMs: budgets.timeoutMs + 1_000,
  });
  if (!("token" in claimed)) {
    const state = await service.getState(scope);
    return {
      code: claimed.code,
      epoch: state?.epoch ?? expectedEpoch,
      health: state?.health ?? "unknown",
    };
  }
  const { findProviderById } = await import("@/repository/provider");
  const provider = await findProviderById(scope.providerId);
  if (!provider) {
    await service.completeProbe({
      lease: claimed,
      succeeded: false,
      nextProbeDelayMs: deterministicProbeBackoffMs(scope, 0),
    });
    const state = await service.getState(scope);
    return {
      code: "not_found",
      epoch: state?.epoch ?? claimed.epoch,
      health: state?.health ?? "open",
    };
  }
  const { executeProviderTest } = await import("@/lib/provider-testing/test-service");
  const startedAt = Date.now();
  const result = await executeProviderTest({
    providerUrl: provider.url,
    apiKey: provider.key,
    providerType: provider.providerType,
    model: budgets.safeModel,
    timeoutMs: budgets.timeoutMs,
    maxOutputTokens: budgets.maxTokensPerProbe,
  });
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  const costUsd = await calculateRecoveryProbeCost({
    model: budgets.safeModel,
    inputTokens,
    outputTokens,
    multiplier: provider.costMultiplier,
  });
  await service.completeProbe({
    lease: claimed,
    succeeded: result.success,
    nextProbeDelayMs: deterministicProbeBackoffMs(scope, 0),
  });
  await accountRecoveryProbe({
    scope,
    model: budgets.safeModel,
    inputTokens,
    outputTokens,
    costUsd,
    succeeded: result.success,
    durationMs: Date.now() - startedAt,
  });
  const state = await service.getState(scope);
  return {
    code: "applied",
    epoch: state?.epoch ?? claimed.epoch,
    health: state?.health ?? "unknown",
  };
}

function effectiveSettings(settings: ResolvedSettings): RecoverySettings {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, value.effective])
  ) as unknown as RecoverySettings;
}

function effectiveProbeBudgets(
  settings: {
    readonly [Key in keyof RecoveryProbeBudgets]: ResolvedSetting<RecoveryProbeBudgets[Key]>;
  }
): RecoveryProbeBudgets {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, value.effective])
  ) as unknown as RecoveryProbeBudgets;
}

export function recoveryRedisPrimaries(redis: DueSchedulerRedis): readonly DueSchedulerRedis[] {
  const cluster = redis as DueSchedulerRedis & {
    nodes?: (role: "master") => readonly DueSchedulerRedis[];
  };
  const primaries = cluster.nodes?.("master") ?? [];
  return primaries.length > 0 ? primaries : [redis];
}

export function stopRecoveryDueScheduler(): void {
  if (dueSchedulerInterval) clearInterval(dueSchedulerInterval);
  dueSchedulerInterval = null;
}

async function exportNonClosedRecoveryStateToLegacy(
  redis: DueSchedulerRedis,
  service: RecoveryV2Service
): Promise<number> {
  const [{ forceOpenCircuitState }, { forceOpenEndpointCircuitState }] = await Promise.all([
    import("@/lib/circuit-breaker"),
    import("@/lib/endpoint-circuit-breaker"),
  ]);
  const { setVendorTypeCircuitManualOpen } = await import("@/lib/vendor-type-circuit-breaker");
  let cursor = "0";
  let exported = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "cb:v2:{*}:state", "COUNT", 100);
    cursor = nextCursor;
    for (const key of keys) {
      const scopeJson = await redis.hget(key, "scope_json");
      if (!scopeJson) continue;
      const scope = parseCanonicalRecoveryScope(scopeJson);
      const state = await service.getState(scope);
      if (state?.health === "closed") continue;
      const target = legacyRollbackTarget(scope);
      if (target.kind === "vendor-type") {
        await setVendorTypeCircuitManualOpen(
          target.vendorId,
          target.providerType as import("@/types/provider").ProviderType,
          true
        );
      } else if (target.kind === "endpoint") {
        await forceOpenEndpointCircuitState(target.endpointId);
      } else {
        await forceOpenCircuitState(target.providerId, { reason: "recovery_v2_rollback_export" });
      }
      exported += 1;
    }
  } while (cursor !== "0");
  return exported;
}

export async function initializeRecoveryRuntime(): Promise<"legacy" | "shadow" | "enforce"> {
  const previousMode = activeRecoveryMode;
  const previousProduction = productionRecoveryService;
  const persisted = await getPersistedRecoveryConfiguration();
  const bindingMode =
    persisted.system.sessionBindingAuthorityMode ??
    getEnvConfig().SESSION_BINDING_AUTHORITY_MODE ??
    "legacy";
  const mode =
    persisted.system.recoveryAuthorityMode ?? getEnvConfig().RECOVERY_AUTHORITY_MODE ?? "legacy";
  if (previousMode === "enforce" && mode !== "enforce" && previousProduction) {
    const rollbackRedis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (!rollbackRedis) throw new Error("recovery_v2_rollback_export_unavailable");
    const exported = await exportNonClosedRecoveryStateToLegacy(
      rollbackRedis as unknown as DueSchedulerRedis,
      previousProduction
    );
    logger.info("Recovery V2 rollback export completed", { exported });
  }
  stopRecoveryDueScheduler();
  productionRecoveryService = null;
  shadowRecoveryService = null;
  providerLimitService = null;
  activeDegradedReconciler = null;
  recoveryNotificationDispatcher = null;
  activeRecoveryMode = mode;
  setProviderRecoveryEvaluator(null);
  setProviderRecoveryValidator(null);
  setProviderRecoveryShadowObserver(null);
  if (mode === "legacy") {
    setRecoveryCompatibilityFacade(null);
    if (bindingMode === "legacy") {
      setSessionBindingRuntime({ mode: "legacy", production: null, shadow: null });
      return mode;
    }
  }

  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) {
    if (mode === "enforce" || bindingMode !== "legacy") throw new Error("recovery_v2_unavailable");
    setRecoveryCompatibilityFacade(null);
    return mode;
  }
  const resolved = await getCachedRecoveryConfiguration();
  const settings = effectiveSettings(resolved.recovery);
  const probeBudgets = effectiveProbeBudgets(resolved.probeBudgets);
  const production = new RecoveryV2Service(redis, settings, "production");
  providerLimitService = new ProviderLimitService(redis, settings.stateRetentionMs);
  recoveryNotificationDispatcher = new RecoveryNotificationDispatcher(
    new RecoveryNotificationDeduplicator(redis as unknown as RecoveryNotificationRedis),
    async (event) => logger.info("Recovery notification", event)
  );
  productionRecoveryService = production;
  const shadow = new RecoveryV2Service(redis, settings, "shadow");
  shadowRecoveryService = shadow;
  await redis.ping();
  if (mode !== "legacy") {
    const target = mode === "shadow" ? shadow : production;
    const [{ findAllProviders }, { getAllHealthStatusAsync }] = await Promise.all([
      import("@/repository/provider"),
      import("@/lib/circuit-breaker"),
    ]);
    const providers = await findAllProviders();
    const providerHealth = await getAllHealthStatusAsync(providers.map((provider) => provider.id));
    for (const provider of providers) {
      const legacy = providerHealth[provider.id]?.circuitState ?? "unknown";
      await target.initializeScope(
        { kind: "provider", providerId: provider.id },
        importLegacyHealth(legacy === "half-open" ? "half-open" : legacy) === "closed"
          ? "closed"
          : "open"
      );
      if (provider.providerVendorId) {
        const { getVendorTypeCircuitInfo } = await import("@/lib/vendor-type-circuit-breaker");
        const vendor = await getVendorTypeCircuitInfo(
          provider.providerVendorId,
          provider.providerType
        );
        await target.initializeScope(
          {
            kind: "vendor-type",
            vendorId: provider.providerVendorId,
            providerType: provider.providerType,
          },
          vendor.circuitState === "closed" && !vendor.manualOpen ? "closed" : "open"
        );
        const { findProviderEndpointsByVendorAndType } = await import(
          "@/repository/provider-endpoints"
        );
        const endpoints = await findProviderEndpointsByVendorAndType(
          provider.providerVendorId,
          provider.providerType
        );
        const { getAllEndpointHealthStatusAsync } = await import("@/lib/endpoint-circuit-breaker");
        const endpointHealth = await getAllEndpointHealthStatusAsync(
          endpoints.map((endpoint) => endpoint.id)
        );
        for (const endpoint of endpoints) {
          await target.initializeScope(
            {
              kind: "endpoint",
              providerId: provider.id,
              endpoint: { kind: "managed", endpointId: endpoint.id },
            },
            endpointHealth[endpoint.id]?.circuitState === "closed" ? "closed" : "open"
          );
        }
      }
    }
  }
  const reconciler = new RecoveryDegradedReconciler(
    {
      list: listPendingDegradedOpenEvidence,
      markReconciled: markDegradedOpenEvidenceReconciled,
    },
    production,
    degradationGate,
    async () => {
      for (const primary of recoveryRedisPrimaries(redis as unknown as DueSchedulerRedis)) {
        let cursor = "0";
        do {
          const [nextCursor, keys] = await primary.scan(
            cursor,
            "MATCH",
            "cb:v2:{*}:state",
            "COUNT",
            100
          );
          cursor = nextCursor;
          for (const key of keys) {
            const scopeJson = await primary.hget(key, "scope_json");
            if (!scopeJson) throw new Error("recovery authority scope identity is missing");
            const state = await production.getState(parseCanonicalRecoveryScope(scopeJson));
            if (!state)
              throw new Error("recovery authority state disappeared during reconciliation");
          }
        } while (cursor !== "0");
      }
    }
  );
  activeDegradedReconciler = reconciler;
  if (!redisWithRecoveryListeners.has(redis)) {
    redisWithRecoveryListeners.add(redis);
    redis.on("error", () => {
      degradationGate.enter();
      recoveryMetrics.add("recovery.degraded", 1, { degraded: "true" });
    });
    redis.on("ready", () => {
      if (!degradationGate.degraded || !activeDegradedReconciler) return;
      void activeDegradedReconciler
        .reconcile()
        .then(() => degradationGate.clearAfterFreshAuthorityRead())
        .catch((error) => logger.error("Recovery degraded reconciliation failed", { error }));
    });
  }
  setSessionBindingRuntime({
    mode: bindingMode,
    production:
      bindingMode === "legacy" || bindingMode === "shadow"
        ? null
        : new SessionBindingV2Service(redis, settings.stateRetentionMs, bindingMode),
    shadow:
      bindingMode === "shadow"
        ? new SessionBindingV2Service(redis, settings.stateRetentionMs, "shadow", "shadow")
        : null,
  });
  const compatibilityFacade = new RecoveryCompatibilityFacade(mode, production, shadow);
  setRecoveryCompatibilityFacade(compatibilityFacade);
  setProviderRecoveryShadowObserver(
    mode === "shadow"
      ? ({ evaluation, legacyAllowed, v2Allowed }) =>
          compatibilityFacade.recordRoutingDecision({
            scopes: evaluation.scopes ?? [],
            legacyAllowed,
            v2Allowed,
          })
      : null
  );
  if (mode === "enforce" || mode === "shadow") {
    const routingService = mode === "shadow" ? shadow : production;
    setProviderRecoveryEvaluator(async (provider) => {
      const scopes = [
        ...(provider.providerVendorId
          ? [
              {
                kind: "vendor-type" as const,
                vendorId: provider.providerVendorId,
                providerType: provider.providerType,
              },
            ]
          : []),
        { kind: "provider" as const, providerId: provider.id },
      ];
      let snapshots;
      try {
        snapshots = await Promise.all(scopes.map((scope) => routingService.getState(scope)));
      } catch {
        degradationGate.enter();
        const degradedBasisPoints = scopes.every((scope) =>
          degradationGate.mayRouteStateless(scope)
        )
          ? 10_000
          : 0;
        return {
          effectiveBasisPoints: mode === "shadow" ? 10_000 : degradedBasisPoints,
          shadowEffectiveBasisPoints: mode === "shadow" ? degradedBasisPoints : undefined,
          halfOpenEligible: false,
          recovering: [],
        };
      }
      if (snapshots.some((snapshot) => !snapshot)) {
        return {
          effectiveBasisPoints: mode === "shadow" ? 10_000 : 0,
          shadowEffectiveBasisPoints: mode === "shadow" ? 0 : undefined,
          halfOpenEligible: false,
          recovering: [],
        };
      }
      const defined = snapshots.filter((snapshot) => snapshot !== null);
      defined.forEach((snapshot, index) =>
        strictnessCache.putAuthoritative(scopes[index], snapshot.health, snapshot.epoch)
      );
      defined.forEach((snapshot, index) => {
        if (snapshot.health !== "recovering") return;
        recoveryMetrics.add("recovery.bps", effectiveRecoveryBasisPoints([snapshot]), {
          scope_kind: scopes[index].kind,
          stage: String(snapshot.recoveryStageIndex),
        });
      });
      return {
        effectiveBasisPoints: mode === "shadow" ? 10_000 : effectiveRecoveryBasisPoints(defined),
        shadowEffectiveBasisPoints:
          mode === "shadow" ? effectiveRecoveryBasisPoints(defined) : undefined,
        halfOpenEligible:
          defined.some((snapshot) => snapshot.health === "half_open") &&
          defined.every(
            (snapshot) =>
              !snapshot.automationPaused &&
              (snapshot.health === "closed" ||
                snapshot.health === "recovering" ||
                snapshot.health === "half_open")
          ),
        scopes: defined.map((snapshot, index) => ({
          scope: scopes[index],
          kind: scopes[index].kind,
          health: snapshot.health,
          basisPoints: effectiveRecoveryBasisPoints([snapshot]),
        })),
        recovering: defined.flatMap((snapshot, index) =>
          snapshot.health === "recovering"
            ? [
                {
                  scope: scopes[index],
                  epoch: snapshot.epoch,
                  stageIndex: snapshot.recoveryStageIndex,
                },
              ]
            : []
        ),
      };
    });
    setProviderRecoveryValidator(
      mode === "shadow"
        ? null
        : async (provider, bucket) => {
            const scopes = [
              ...(provider.providerVendorId
                ? [
                    {
                      kind: "vendor-type" as const,
                      vendorId: provider.providerVendorId,
                      providerType: provider.providerType,
                    },
                  ]
                : []),
              { kind: "provider" as const, providerId: provider.id },
            ];
            for (const scope of scopes) {
              let snapshot;
              try {
                snapshot = await production.getState(scope);
              } catch {
                degradationGate.enter();
                if (!degradationGate.mayRouteStateless(scope)) return false;
                continue;
              }
              if (
                !snapshot ||
                snapshot.automationPaused ||
                snapshot.health === "open" ||
                snapshot.health === "probing" ||
                snapshot.health === "half_open"
              )
                return false;
              strictnessCache.putAuthoritative(scope, snapshot.health, snapshot.epoch);
              if (snapshot.health === "recovering") {
                const result = await production.validateRecoveryAdmission({
                  scope,
                  expectedEpoch: snapshot.epoch,
                  expectedStageIndex: snapshot.recoveryStageIndex,
                  bucket,
                });
                if (result.code !== "applied") return false;
              }
            }
            return true;
          }
    );
    if (
      mode === "enforce" &&
      settings.activeProbesEnabled &&
      probeBudgets.safeModel &&
      !dueSchedulerInterval
    ) {
      const { findAllProviders } = await import("@/repository/provider");
      const maximumCostMultiplier = Math.max(
        1,
        ...(await findAllProviders()).map((provider) => provider.costMultiplier)
      );
      const maximumProbeCost = await calculateRecoveryProbeCost({
        model: probeBudgets.safeModel,
        inputTokens: probeBudgets.maxTokensPerProbe,
        outputTokens: probeBudgets.maxTokensPerProbe,
        multiplier: maximumCostMultiplier,
      });
      const schedulerRedis = redis as unknown as DueSchedulerRedis;
      const executeProbe = async ({
        scope,
        safeModel,
        timeoutMs,
        maxTokens,
      }: {
        scope: RecoveryScope;
        safeModel: string;
        timeoutMs: number;
        maxTokens: number;
      }) => {
        if (scope.kind === "vendor-type") return { succeeded: false, costUsd: null };
        const { findProviderById } = await import("@/repository/provider");
        const provider = await findProviderById(scope.providerId);
        if (!provider) return { succeeded: false, costUsd: null };
        const { executeProviderTest } = await import("@/lib/provider-testing/test-service");
        const result = await executeProviderTest({
          providerUrl: provider.url,
          apiKey: provider.key,
          providerType: provider.providerType,
          model: safeModel,
          timeoutMs,
          maxOutputTokens: maxTokens,
        });
        const inputTokens = result.usage?.inputTokens ?? 0;
        const outputTokens = result.usage?.outputTokens ?? 0;
        return {
          succeeded: result.success,
          costUsd: await calculateRecoveryProbeCost({
            model: safeModel,
            inputTokens,
            outputTokens,
            multiplier: provider.costMultiplier,
          }),
          inputTokens,
          outputTokens,
        };
      };
      const schedulers = recoveryRedisPrimaries(schedulerRedis).map(
        (primary) =>
          new RecoveryDueScheduler(schedulerRedis, production, probeBudgets, executeProbe, {
            accounting: accountRecoveryProbe,
            reservedCostUsd: maximumProbeCost ?? probeBudgets.dailyCostUsd,
            scanRedis: primary,
          })
      );
      const cursors = schedulers.map(() => "0");
      const cycle = async () => {
        await schedulers[0].tick();
        for (let index = 0; index < schedulers.length; index += 1) {
          const reconciled = await schedulers[index].reconcile(cursors[index]);
          recoveryMetrics.add("recovery.due_index_drift", reconciled.repaired, {
            result: reconciled.repaired > 0 ? "repaired" : "clean",
          });
          cursors[index] = reconciled.cursor;
        }
      };
      const runCycle = () => {
        void cycle().catch((error) => logger.error("Recovery scheduler cycle failed", { error }));
      };
      runCycle();
      dueSchedulerInterval = setInterval(runCycle, 5_000);
      dueSchedulerInterval.unref();
    }
  }
  return mode;
}
