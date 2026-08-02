import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const redis = {
    ping: vi.fn(async () => "PONG"),
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    scan: vi.fn(async () => ["0", []] as [string, string[]]),
    hget: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    eval: vi.fn(async () => [1, "ok"]),
  };
  const settings = {
    openDurationMs: 100,
    windowDurationMs: 1_000,
    bucketDurationMs: 100,
    minimumRealOutcomes: 1,
    failureThreshold: 1,
    maximumFailureRate: 0.5,
    slowCallDurationMs: 100,
    maximumSlowCallRate: 0.5,
    consecutiveHard5xxThreshold: 2,
    rampDurationMs: 1_000,
    stableDurationMs: 1_000,
    halfOpenMaxConcurrency: 1,
    halfOpenSuccessThreshold: 1,
    stateRetentionMs: 60_000,
    passiveHalfOpenEnabled: true,
    recoveryTrafficEnabled: true,
    activeProbesEnabled: false,
  };
  const budgets = {
    safeModel: "safe-model",
    globalConcurrency: 1,
    providerConcurrency: 1,
    requestsPerMinute: 10,
    maxTokensPerProbe: 16,
    timeoutMs: 100,
    dailyCostUsd: 1,
  };
  const resolved = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, effective]) => [
        key,
        { configured: null, effective, source: "code" },
      ])
    );
  return {
    mode: "legacy" as "legacy" | "shadow" | "enforce",
    bindingMode: "legacy" as "legacy" | "shadow" | "v2_dual_write" | "v2_only",
    redisAvailable: true,
    listeners,
    redis,
    settings,
    budgets,
    resolved,
    state: {
      health: "closed",
      epoch: 1,
      recoveryStageIndex: 0,
      automationPaused: false,
      closedStableAt: 1,
    } as any,
    claimProbe: { token: "probe", epoch: 1 },
    providerExists: true,
    getStateError: false,
    recordOutcomeError: false,
    evaluator: null as null | ((provider: any) => Promise<any>),
    validator: null as null | ((provider: any, bucket: number) => Promise<boolean>),
    shadowObserver: null as null | ((input: any) => void),
    claimComposite: vi.fn(async () => ({ code: "applied", leases: [] })),
    evaluateComposite: vi.fn(async () => ({ code: "allowed" })),
    recordProbe: vi.fn(async () => undefined),
    trackCost: vi.fn(async () => undefined),
    schedulerTick: vi.fn(async () => 0),
    schedulerReconcile: vi.fn(async () => ({ cursor: "0", repaired: 0 })),
    schedulerExecute: null as null | ((input: any) => Promise<any>),
    schedulerAccounting: null as null | ((input: any) => Promise<any>),
    executeProbe: vi.fn(async () => ({
      success: true,
      usage: { inputTokens: 2, outputTokens: 3 },
    })),
  };
});

vi.mock("@/lib/config/env.schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/env.schema")>()),
  getEnvConfig: () => ({
    RECOVERY_AUTHORITY_MODE: null,
    SESSION_BINDING_AUTHORITY_MODE: null,
  }),
}));
vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => (h.redisAvailable ? h.redis : null),
}));
vi.mock("@/repository/recovery-config", () => ({
  getPersistedRecoveryConfiguration: async () => ({
    system: {
      recoveryAuthorityMode: h.mode,
      sessionBindingAuthorityMode: h.bindingMode,
    },
  }),
  listPendingDegradedOpenEvidence: async () => [],
  markDegradedOpenEvidenceReconciled: async () => 0,
  upsertDegradedOpenEvidence: vi.fn(async () => undefined),
}));
vi.mock("@/repository/recovery-probe-ledger", () => ({
  recordRecoveryProbeUsage: h.recordProbe,
}));
vi.mock("@/lib/recovery/config-cache", () => ({
  getCachedRecoveryConfiguration: async () => ({
    recovery: h.resolved(h.settings),
    probeBudgets: h.resolved(h.budgets),
  }),
}));
vi.mock("@/lib/redis/recovery-v2-service", () => ({
  RecoveryV2Service: class {
    getState = vi.fn(async () => {
      if (h.getStateError) throw new Error("redis disconnected");
      return { ...h.state };
    });
    initializeScope = vi.fn(async () => ({ code: "applied" }));
    validateRecoveryAdmission = vi.fn(async () => ({ code: "applied" }));
    completeHalfOpenTrial = vi.fn(async () => ({ code: "applied" }));
    recordAttemptOutcome = vi.fn(async ({ disposition }: { disposition: string }) => {
      if (h.recordOutcomeError) throw new Error("settlement disconnected");
      h.state = {
        ...h.state,
        health: disposition === "success" ? "closed" : "open",
        epoch: h.state.epoch + 1,
      };
      return { code: "applied" };
    });
    claimProbe = vi.fn(async ({ scope }: { scope: unknown }) => ({ ...h.claimProbe, scope }));
    completeProbe = vi.fn(async () => ({ code: "applied" }));
    administrate = vi.fn(async () => ({ code: "applied" }));
  },
}));
vi.mock("@/lib/redis/session-binding-v2-service", () => ({
  SessionBindingV2Service: class {},
}));
vi.mock("@/lib/recovery/composite-admission", () => ({
  claimCompositeHalfOpen: h.claimComposite,
  evaluateCompositeScopes: h.evaluateComposite,
}));
vi.mock("@/lib/recovery/routing-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recovery/routing-admission")>();
  return {
    ...actual,
    setProviderRecoveryEvaluator: (value: typeof h.evaluator) => {
      h.evaluator = value;
    },
    setProviderRecoveryValidator: (value: typeof h.validator) => {
      h.validator = value;
    },
    setProviderRecoveryShadowObserver: (value: typeof h.shadowObserver) => {
      h.shadowObserver = value;
    },
  };
});
vi.mock("@/lib/recovery/probe-scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recovery/probe-scheduler")>();
  return {
    ...actual,
    RecoveryDueScheduler: class {
      constructor(
        _redis: unknown,
        _service: unknown,
        _budgets: unknown,
        execute: any,
        options: any
      ) {
        h.schedulerExecute = execute;
        h.schedulerAccounting = options.accounting;
      }
      tick = h.schedulerTick;
      reconcile = h.schedulerReconcile;
    },
  };
});
vi.mock("@/repository/provider", () => ({
  findAllProviders: async () => [
    {
      id: 7,
      providerVendorId: 3,
      providerType: "claude",
      costMultiplier: 1,
    },
  ],
  findProviderById: async () =>
    h.providerExists
      ? {
          id: 7,
          url: "https://provider.invalid",
          key: "secret",
          providerType: "claude",
          costMultiplier: 1,
          limit5hResetMode: "rolling",
          dailyResetTime: "00:00",
          dailyResetMode: "fixed",
        }
      : null,
}));
vi.mock("@/repository/provider-endpoints", () => ({
  findProviderEndpointsByVendorAndType: async () => [{ id: 9 }],
}));
vi.mock("@/lib/circuit-breaker", () => ({
  getAllHealthStatusAsync: async () => ({ 7: { circuitState: "closed" } }),
  forceOpenCircuitState: vi.fn(async () => undefined),
}));
vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  getVendorTypeCircuitInfo: async () => ({ circuitState: "closed", manualOpen: false }),
  setVendorTypeCircuitManualOpen: vi.fn(async () => undefined),
}));
vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  getAllEndpointHealthStatusAsync: async () => ({ 9: { circuitState: "closed" } }),
  forceOpenEndpointCircuitState: vi.fn(async () => undefined),
}));
vi.mock("@/lib/provider-testing/test-service", () => ({ executeProviderTest: h.executeProbe }));
vi.mock("@/repository/model-price", () => ({
  findLatestPriceByModel: async () => ({ priceData: {} }),
}));
vi.mock("@/lib/utils/cost-calculation", () => ({
  calculateRequestCost: () => ({ toNumber: () => 0.25 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: { trackProviderRecoveryProbeCost: h.trackCost },
}));

describe("recovery runtime", () => {
  let runtime: typeof import("@/lib/recovery/runtime");

  beforeAll(async () => {
    runtime = await import("@/lib/recovery/runtime");
  });

  it("initializes legacy, shadow, and enforce authority without shadow side effects", async () => {
    const primaryA = {} as any;
    const primaryB = {} as any;
    expect(runtime.recoveryRedisPrimaries({ nodes: () => [primaryA, primaryB] } as any)).toEqual([
      primaryA,
      primaryB,
    ]);
    expect(runtime.recoveryRedisPrimaries(h.redis as any)).toEqual([h.redis]);
    h.mode = "legacy";
    h.bindingMode = "legacy";
    expect(await runtime.initializeRecoveryRuntime()).toBe("legacy");
    expect(runtime.getRecoveryAuthorityMode()).toBe("legacy");
    expect(
      await runtime.prepareCompositeRecoveryAttempt({
        scopes: [],
        identity: {
          requestId: "r",
          attemptOutcomeId: "a",
          attemptNumber: 1,
          attemptKind: "primary",
        },
        leaseMs: 100,
        recoveryBucket: null,
      })
    ).toBe(true);

    h.mode = "shadow";
    h.bindingMode = "shadow";
    expect(await runtime.initializeRecoveryRuntime()).toBe("shadow");
    expect(runtime.getRecoveryManagementService()).not.toBeNull();
    expect(h.evaluator).not.toBeNull();
    const shadowEvaluation = await h.evaluator!({
      id: 7,
      providerVendorId: 3,
      providerType: "claude",
    });
    expect(shadowEvaluation.effectiveBasisPoints).toBe(10_000);
    expect(await runtime.runRecoveryProbe({ kind: "provider", providerId: 7 }, 1)).toMatchObject({
      code: "shadow_probe_disabled",
    });

    h.mode = "enforce";
    h.bindingMode = "v2_dual_write";
    h.settings.activeProbesEnabled = true;
    expect(await runtime.initializeRecoveryRuntime()).toBe("enforce");
    expect(runtime.getProductionRecoveryService()).not.toBeNull();
    expect(runtime.getRecoveryProviderLimitService()).not.toBeNull();
    expect(
      await h.schedulerExecute!({
        scope: { kind: "vendor-type", vendorId: 1, providerType: "x" },
        safeModel: "safe-model",
        timeoutMs: 10,
        maxTokens: 4,
      })
    ).toMatchObject({ succeeded: false, costUsd: null });
    h.providerExists = false;
    expect(
      await h.schedulerExecute!({
        scope: { kind: "provider", providerId: 7 },
        safeModel: "safe-model",
        timeoutMs: 10,
        maxTokens: 4,
      })
    ).toMatchObject({ succeeded: false, costUsd: null });
    h.providerExists = true;
    expect(
      await h.schedulerExecute!({
        scope: { kind: "provider", providerId: 7 },
        safeModel: "safe-model",
        timeoutMs: 10,
        maxTokens: 4,
      })
    ).toMatchObject({ succeeded: true, costUsd: 0.25 });
    await h.schedulerAccounting!({
      scope: { kind: "provider", providerId: 7 },
      model: "safe-model",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.25,
      succeeded: true,
      durationMs: 1,
    });
  });

  it("evaluates, claims, and finalizes recovering and half-open attempts exactly once", async () => {
    const scope = { kind: "provider" as const, providerId: 7 };
    h.state = { ...h.state, health: "recovering", epoch: 5, recoveryStageIndex: 1 };
    expect((await h.evaluator!({ id: 7, providerType: "claude" })).effectiveBasisPoints).toBe(
      2_500
    );
    expect(await h.validator!({ id: 7, providerType: "claude" }, 100)).toBe(true);

    h.state = { ...h.state, health: "half_open" };
    h.claimComposite.mockResolvedValueOnce({
      code: "applied",
      leases: [
        {
          scope,
          token: "trial",
          epoch: h.state.epoch,
          requestId: "request",
          attemptOutcomeId: "attempt-runtime",
          expiresAt: Date.now() + 100,
        },
      ],
    });
    const identity = {
      requestId: "request",
      attemptOutcomeId: "attempt-runtime",
      attemptNumber: 1,
      attemptKind: "primary" as const,
    };
    expect(
      await runtime.prepareCompositeRecoveryAttempt({
        scopes: [scope],
        identity,
        leaseMs: 100,
        recoveryBucket: 100,
      })
    ).toBe(true);
    await runtime.finalizeRecoveryAttempt({
      identity,
      effects: [{ scope, disposition: "success", reason: "upstream_success" }],
      retrySafety: "pre_commit_only",
      upstreamCommitted: true,
      downstreamCommitted: true,
      durationMs: 5,
    });
    await runtime.finalizeRecoveryAttempt({
      identity,
      effects: [{ scope, disposition: "success", reason: "upstream_success" }],
      retrySafety: "pre_commit_only",
      upstreamCommitted: true,
      downstreamCommitted: true,
      durationMs: 5,
    });
  });

  it("maps compatibility resets to safe restart validation in enforce mode", async () => {
    h.mode = "enforce";
    h.bindingMode = "v2_dual_write";
    h.state = { ...h.state, health: "open", epoch: 11 };
    await runtime.initializeRecoveryRuntime();

    const service = runtime.getProductionRecoveryService();
    expect(service).not.toBeNull();
    const administrate = service!.administrate as ReturnType<typeof vi.fn>;
    const stale = await runtime.restartRecoveryValidation({
      scope: { kind: "provider", providerId: 7 },
      expectedEpoch: 10,
    });
    expect(stale).toMatchObject({ handled: true, result: { code: "stale_epoch", epoch: 11 } });

    const applied = await runtime.restartRecoveryValidation({
      scope: { kind: "provider", providerId: 7 },
      reason: "  compatibility test  ",
    });
    expect(applied).toMatchObject({ handled: true, result: { code: "applied" } });
    expect(administrate).toHaveBeenLastCalledWith({
      scope: { kind: "provider", providerId: 7 },
      action: "reset",
      expectedEpoch: 11,
      reason: "compatibility test",
    });

    h.state = null as any;
    await expect(
      runtime.restartRecoveryValidation({
        scope: { kind: "provider", providerId: 7 },
      })
    ).resolves.toMatchObject({ handled: true, result: { code: "applied" } });
    h.state = { health: "closed", epoch: 1, recoveryStageIndex: 0, automationPaused: false } as any;
  });

  it("runs bounded management probes and handles unavailable variants", async () => {
    const scope = { kind: "provider" as const, providerId: 7 };
    expect(
      await runtime.runRecoveryProbe({ kind: "vendor-type", vendorId: 1, providerType: "x" }, 1)
    ).toMatchObject({ code: "unsupported_scope" });
    h.providerExists = false;
    expect(await runtime.runRecoveryProbe(scope, 1)).toMatchObject({ code: "not_found" });
    h.providerExists = true;
    expect(await runtime.runRecoveryProbe(scope, 1)).toMatchObject({ code: "applied" });
    expect(h.recordProbe).toHaveBeenCalled();
    expect(h.trackCost).toHaveBeenCalled();
    h.claimProbe = { code: "stale_epoch" } as any;
    expect(await runtime.runRecoveryProbe(scope, 99)).toMatchObject({ code: "stale_epoch" });
    h.claimProbe = { token: "probe", epoch: 1 };
  });

  it("fails closed on degraded reads and reconciles a fresh authority snapshot", async () => {
    const scope = { kind: "provider" as const, providerId: 7 };
    h.getStateError = true;
    expect(
      await runtime.prepareCompositeRecoveryAttempt({
        scopes: [scope],
        identity: {
          requestId: "degraded",
          attemptOutcomeId: "degraded-attempt",
          attemptNumber: 1,
          attemptKind: "primary",
        },
        leaseMs: 100,
        recoveryBucket: null,
      })
    ).toBe(false);
    expect(runtime.recoveryRuntimeIsDegraded()).toBe(true);
    h.getStateError = false;
    h.redis.scan.mockResolvedValueOnce(["0", ["cb:v2:{scope}:state"]]);
    h.redis.hget.mockResolvedValueOnce(JSON.stringify(["recovery-scope", 1, "provider", 7]));
    h.listeners.get("ready")?.();
    await vi.waitFor(() => expect(runtime.recoveryRuntimeIsDegraded()).toBe(false));
  });

  it("exports non-closed state conservatively during runtime rollback", async () => {
    h.state = { ...h.state, health: "open" };
    h.redis.scan.mockResolvedValueOnce(["0", ["cb:v2:{scope}:state"]]);
    h.redis.hget.mockResolvedValueOnce(JSON.stringify(["recovery-scope", 1, "provider", 7]));
    h.mode = "shadow";
    h.bindingMode = "shadow";
    expect(await runtime.initializeRecoveryRuntime()).toBe("shadow");
  });

  it("fails closed when Redis authority is unavailable", async () => {
    h.redisAvailable = false;
    h.mode = "enforce";
    await expect(runtime.initializeRecoveryRuntime()).rejects.toThrow("recovery_v2_unavailable");
    await expect(
      runtime.restartRecoveryValidation({ scope: { kind: "provider", providerId: 7 } })
    ).resolves.toEqual({ handled: false });
    h.redisAvailable = true;
    runtime.stopRecoveryDueScheduler();
  });
});
