import { describe, expect, it, vi } from "vitest";
import {
  claimCompositeHalfOpen,
  evaluateCompositeScopes,
} from "@/lib/recovery/composite-admission";
import { createAttemptIdentity } from "@/lib/recovery/attempt-identity";
import { AttemptOutcomeFinalizer, mayRetryAttempt } from "@/lib/recovery/attempt-finalizer";
import {
  evaluateFailbackAdmission,
  failbackAbortCooldownMs,
  FailbackSemaphore,
  resolveEffectiveFailbackMode,
} from "@/lib/recovery/failback";
import {
  admitRecoveryPriorityLayer,
  admitRecoveryPriorityLayerWithTrials,
  effectiveRecoveryBasisPoints,
} from "@/lib/recovery/routing-admission";
import type { RecoveryScope, SessionFailbackSettings } from "@/lib/recovery/contracts";

const provider = (providerId: number): RecoveryScope => ({ kind: "provider", providerId });
const settings: SessionFailbackSettings = {
  mode: "safe_auto",
  delayMs: 100,
  retryCooldownMs: 200,
  rolloutPercent: 100,
  maxConcurrentMigrations: 2,
  migrationWaitMs: 100,
};

describe("recovery orchestration", () => {
  it("uses one shared bucket and spills an empty priority layer", () => {
    const result = admitRecoveryPriorityLayer({
      routeKey: "session-a",
      candidates: [
        { value: "p0-a", priority: 0, effectiveBasisPoints: 0 },
        { value: "p0-b", priority: 0, effectiveBasisPoints: 0 },
        { value: "p1", priority: 1, effectiveBasisPoints: 10_000 },
      ],
    });
    expect(result).toMatchObject({ admitted: ["p1"], priority: 1 });
    expect(
      admitRecoveryPriorityLayer({
        routeKey: "session-a",
        candidates: [
          { value: "a", priority: 0, effectiveBasisPoints: 10_000 },
          { value: "b", priority: 0, effectiveBasisPoints: 10_000 },
        ],
      }).admitted
    ).toEqual(["a", "b"]);
  });

  it("takes the strictest applicable recovery state", () => {
    expect(
      effectiveRecoveryBasisPoints([
        { health: "closed", recoveryStageIndex: 0, automationPaused: false },
        { health: "recovering", recoveryStageIndex: 1, automationPaused: false },
      ])
    ).toBe(2_500);
    expect(
      effectiveRecoveryBasisPoints([
        { health: "closed", recoveryStageIndex: 0, automationPaused: true },
      ])
    ).toBe(0);
  });

  it("selects a higher-priority HALF_OPEN trial before spilling to a closed lower tier", () => {
    const result = admitRecoveryPriorityLayerWithTrials({
      routeKey: "session-half-open",
      candidates: [
        {
          value: "p0-trial",
          priority: 0,
          effectiveBasisPoints: 0,
          halfOpenEligible: true,
        },
        {
          value: "p1-closed",
          priority: 1,
          effectiveBasisPoints: 10_000,
          halfOpenEligible: false,
        },
      ],
    });
    expect(result).toMatchObject({
      admitted: ["p0-trial"],
      priority: 0,
      halfOpenTrial: true,
    });
  });

  it("claims half-open scopes in order and releases in reverse on partial failure", async () => {
    const released: number[] = [];
    const service = {
      getState: vi.fn(async (_scope: RecoveryScope) => ({
        health: "half_open" as const,
        epoch: 2,
        automationPaused: false,
        recoveryStageIndex: 0,
      })),
      claimHalfOpenTrial: vi.fn(async ({ scope }: { scope: RecoveryScope }) =>
        scope.kind === "provider" && scope.providerId === 2
          ? { code: "capacity_exhausted" }
          : {
              scope,
              epoch: 2,
              token: `t${scope.kind}`,
              requestId: "request",
              attemptOutcomeId: "attempt",
              expiresAt: 100,
            }
      ),
      releaseHalfOpenTrial: vi.fn(async (lease: { scope: RecoveryScope }) => {
        if (lease.scope.kind === "provider") released.push(lease.scope.providerId);
      }),
    };
    const result = await claimCompositeHalfOpen({
      service,
      scopes: [provider(2), provider(1)],
      identity: createAttemptIdentity("request", 0, "primary", () => "id"),
      leaseMs: 1_000,
      maximumLeaseMs: 100,
    });
    expect(result.code).toBe("rejected");
    expect(released).toEqual([1]);
    expect(service.claimHalfOpenTrial.mock.calls[0][0].leaseMs).toBe(100);
  });

  it("blocks unknown and paused composite scopes", async () => {
    const scope = provider(1);
    expect(
      await evaluateCompositeScopes(
        { getState: async () => null, claimHalfOpenTrial: vi.fn(), releaseHalfOpenTrial: vi.fn() },
        [scope]
      )
    ).toEqual({ code: "blocked", scope });
  });

  it("replays only missing outcome scopes after partial settlement", async () => {
    let failSecond = true;
    const calls: number[] = [];
    const recovery = {
      getState: async () => ({ epoch: 3 }),
      recordAttemptOutcome: async ({ scope }: { scope: RecoveryScope }) => {
        const id = scope.kind === "provider" ? scope.providerId : 0;
        calls.push(id);
        if (id === 2 && failSecond) {
          failSecond = false;
          throw new Error("disconnect");
        }
        return { code: "applied" };
      },
    };
    const finalizer = new AttemptOutcomeFinalizer(
      {
        identity: createAttemptIdentity("request", 0, "primary", () => "outcome"),
        effects: [provider(1), provider(2)].map((scope) => ({
          scope,
          disposition: "success" as const,
          reason: "ok",
        })),
        providerLimit: null,
        retrySafety: "pre_commit_only",
        upstreamCommitted: false,
        downstreamCommitted: false,
        durationMs: 1,
      },
      recovery,
      null
    );
    const owner = finalizer.claimOwner();
    await expect(finalizer.finalize(owner)).rejects.toThrow("disconnect");
    await finalizer.finalize(owner);
    expect(calls).toEqual([1, 2, 2]);
    expect((await finalizer.finalize(owner)).status).toBe("duplicate");
  });

  it("validates finalizer ownership, rejected settlements, pending scopes, and cooldowns", async () => {
    const scope = provider(3);
    const applyCooldown = vi.fn(async () => undefined);
    const unavailable = new AttemptOutcomeFinalizer(
      {
        identity: createAttemptIdentity("request", 0, "primary", () => "missing"),
        effects: [{ scope, disposition: "failure", reason: "timeout" }],
        providerLimit: null,
        retrySafety: "never",
        upstreamCommitted: false,
        downstreamCommitted: false,
        durationMs: 10,
      },
      { getState: async () => null, recordAttemptOutcome: vi.fn() },
      { applyCooldown }
    );
    expect(unavailable.reportPending()).toHaveLength(1);
    await expect(unavailable.finalize(Symbol("not-owner"))).rejects.toThrow("local owner token");
    const unavailableOwner = unavailable.claimOwner();
    expect(() => unavailable.claimOwner()).toThrow("already has an owner");
    await expect(unavailable.finalize(Symbol("wrong-owner"))).rejects.toThrow("local owner token");
    await expect(unavailable.finalize(unavailableOwner)).rejects.toThrow("scope is unavailable");

    const rejected = new AttemptOutcomeFinalizer(
      {
        ...unavailable.outcome,
        identity: createAttemptIdentity("request", 1, "retry", () => "rejected"),
        providerLimit: {
          scope: { kind: "credential_limit", providerId: 3, credentialFingerprint: "abc" },
          disposition: "cooldown",
          retryAfterMs: 1_000,
          reason: "rate_limit",
        },
      },
      {
        getState: async () => ({ epoch: 2 }),
        recordAttemptOutcome: vi.fn().mockResolvedValueOnce({ code: "stale_epoch" }),
      },
      { applyCooldown }
    );
    const rejectedOwner = rejected.claimOwner();
    await expect(rejected.finalize(rejectedOwner)).rejects.toThrow("stale_epoch");

    const applied = new AttemptOutcomeFinalizer(
      rejected.outcome,
      {
        getState: async () => ({ epoch: 2 }),
        recordAttemptOutcome: async () => ({ code: "duplicate" }),
      },
      { applyCooldown }
    );
    await applied.finalize(applied.claimOwner());
    expect(applyCooldown).toHaveBeenCalledTimes(1);
    expect(applied.reportPending()).toEqual([]);
  });

  it("enforces retry commit contracts", () => {
    expect(
      mayRetryAttempt({
        retrySafety: "pre_commit_only",
        upstreamCommitted: false,
        downstreamCommitted: false,
      })
    ).toBe(true);
    expect(
      mayRetryAttempt({
        retrySafety: "pre_commit_only",
        upstreamCommitted: true,
        downstreamCommitted: false,
      })
    ).toBe(false);
    expect(
      mayRetryAttempt({
        retrySafety: "idempotent",
        upstreamCommitted: true,
        downstreamCommitted: false,
      })
    ).toBe(true);
    expect(
      mayRetryAttempt({
        retrySafety: "idempotent",
        upstreamCommitted: false,
        downstreamCommitted: true,
      })
    ).toBe(false);
  });

  it("resolves API-key mode and every fundamental failback gate", () => {
    expect(
      resolveEffectiveFailbackMode({
        apiKeyOverride: "sticky",
        system: { configured: "safe_auto", effective: "safe_auto", source: "system" },
      })
    ).toEqual({ configured: "sticky", effective: "sticky", source: "api_key" });
    const base = {
      sessionId: "session",
      mode: "safe_auto" as const,
      settings,
      binding: {
        state: "stable" as const,
        generation: 2,
        bindingReason: "failover" as const,
        providerId: 2,
        effectivePriority: 2,
        failedOverFromProviderId: 1,
        failedOverFromPriority: 0,
        failedOverAt: 100,
        failbackCooldownUntil: null,
      },
      endpointReplayable: true,
      requestBlocked: false,
      originHealth: "closed" as const,
      originClosedStableAt: 100,
      originEligible: true,
      originPreferred: true,
      originEffectivePriority: 0,
      now: 500,
    };
    expect(evaluateFailbackAdmission(base)).toMatchObject({ admitted: true, originProviderId: 1 });
    expect(evaluateFailbackAdmission({ ...base, endpointReplayable: false })).toEqual({
      admitted: false,
      reason: "endpoint_not_replayable",
    });
    expect(evaluateFailbackAdmission({ ...base, originEffectivePriority: 2 })).toEqual({
      admitted: false,
      reason: "origin_not_higher_priority",
    });
    expect(evaluateFailbackAdmission({ ...base, now: 150 })).toEqual({
      admitted: false,
      reason: "delay_not_elapsed",
    });

    const skipCases: Array<[string, Parameters<typeof evaluateFailbackAdmission>[0]]> = [
      ["stateless", { ...base, sessionId: null }],
      ["sticky_mode", { ...base, mode: "sticky" }],
      ["not_failover_binding", { ...base, binding: null }],
      ["migration_in_progress", { ...base, binding: { ...base.binding, state: "migrating" } }],
      ["endpoint_not_replayable", { ...base, endpointReplayable: false }],
      ["request_blocked", { ...base, requestBlocked: true }],
      ["origin_not_closed", { ...base, originHealth: "open" }],
      ["origin_not_stable", { ...base, originClosedStableAt: null }],
      ["origin_no_longer_preferred", { ...base, originPreferred: false }],
      ["origin_ineligible", { ...base, originEligible: false }],
      ["origin_not_higher_priority", { ...base, originEffectivePriority: 2 }],
      ["delay_not_elapsed", { ...base, now: 150 }],
      ["cooldown_active", { ...base, binding: { ...base.binding, failbackCooldownUntil: 600 } }],
      ["rollout_miss", { ...base, settings: { ...settings, rolloutPercent: 0 } }],
    ];
    for (const [reason, input] of skipCases) {
      expect(evaluateFailbackAdmission(input)).toEqual({ admitted: false, reason });
    }
  });

  it("writes failback cooldown only after target dispatch", () => {
    expect(failbackAbortCooldownMs(false, 30_000)).toBe(0);
    expect(failbackAbortCooldownMs(true, 30_000)).toBe(30_000);
  });

  it("keeps sticky sessions stable and samples safe-auto rollout deterministically", () => {
    const base = {
      sessionId: "session-0",
      mode: "safe_auto" as const,
      settings: { ...settings, rolloutPercent: 10 },
      binding: {
        state: "stable" as const,
        generation: 2,
        bindingReason: "failover" as const,
        providerId: 2,
        effectivePriority: 2,
        failedOverFromProviderId: 1,
        failedOverFromPriority: 0,
        failedOverAt: 100,
        failbackCooldownUntil: null,
      },
      endpointReplayable: true,
      requestBlocked: false,
      originHealth: "closed" as const,
      originClosedStableAt: 100,
      originEligible: true,
      originPreferred: true,
      originEffectivePriority: 0,
      now: 1_000,
    };
    let admitted = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const sessionId = `soak-${index}`;
      const first = evaluateFailbackAdmission({ ...base, sessionId });
      const second = evaluateFailbackAdmission({ ...base, sessionId });
      expect(second).toEqual(first);
      if (first.admitted) admitted += 1;
      expect(evaluateFailbackAdmission({ ...base, sessionId, mode: "sticky" })).toEqual({
        admitted: false,
        reason: "sticky_mode",
      });
    }
    expect(admitted).toBeGreaterThan(70);
    expect(admitted).toBeLessThan(130);
  });

  it("claims, renews, and releases bounded failback semaphore leases", async () => {
    const evalRedis = vi
      .fn()
      .mockResolvedValueOnce([1, 1_500])
      .mockResolvedValueOnce([1, 2_000])
      .mockResolvedValueOnce([1, 2_001])
      .mockResolvedValueOnce([0, 2_002]);
    const semaphore = new FailbackSemaphore({ eval: evalRedis }, "failback:test");
    const lease = await semaphore.claim(2, 500, "token");
    expect(lease).toEqual({ token: "token", expiresAt: 1_500 });
    expect(await semaphore.renew(lease!, 500)).toEqual({ token: "token", expiresAt: 2_000 });
    await semaphore.release(lease!);
    expect(await semaphore.claim(2, 500, "blocked")).toBeNull();
    expect(evalRedis).toHaveBeenCalledWith(
      expect.stringContaining("ZREMRANGEBYSCORE"),
      1,
      "failback:test",
      "claim",
      "token",
      "500",
      "2"
    );
  });

  it("rejects malformed semaphore results and missing renewals", async () => {
    const semaphore = new FailbackSemaphore({
      eval: vi.fn().mockResolvedValueOnce("bad").mockResolvedValueOnce([0, 5]),
    });
    await expect(semaphore.claim(1, 100, "token")).rejects.toThrow("must be an array");
    await expect(semaphore.renew({ token: "token", expiresAt: 1 }, 100)).resolves.toBeNull();
  });
});
