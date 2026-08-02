import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CODE_RECOVERY_DEFAULTS } from "@/lib/recovery/config";
import type { RecoveryScope, RecoverySettings } from "@/lib/recovery/contracts";
import {
  recoveryRedisHashTag,
  recoveryScopeKeys,
  redisClusterSlot,
} from "@/lib/redis/recovery-v2-keys";
import {
  type RecoveryCommandResult,
  type RecoveryTrialLease,
  RecoveryV2Service,
} from "@/lib/redis/recovery-v2-service";

const redisUrl = process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379";
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, db: 11 });

const settings: RecoverySettings = {
  ...CODE_RECOVERY_DEFAULTS,
  openDurationMs: 5,
  windowDurationMs: 1_000,
  bucketDurationMs: 100,
  minimumRealOutcomes: 2,
  failureThreshold: 2,
  maximumFailureRate: 0.25,
  slowCallDurationMs: 10,
  maximumSlowCallRate: 0.25,
  rampDurationMs: 100,
  stableDurationMs: 20,
  halfOpenMaxConcurrency: 1,
  halfOpenSuccessThreshold: 2,
  stateRetentionMs: 5_000,
};

const service = new RecoveryV2Service(redis, settings);

function providerScope(providerId: number): RecoveryScope {
  return { kind: "provider", providerId };
}

function isCommandResult(value: unknown): value is RecoveryCommandResult {
  return Boolean(value && typeof value === "object" && "code" in value);
}

async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function enterHalfOpen(scope: RecoveryScope) {
  const initialized = await service.initializeScope(scope, "open");
  expect(initialized.code).toBe("applied");
  await wait(7);
  const claimed = await service.claimPassiveHalfOpen(scope, initialized.epoch);
  expect(claimed).toMatchObject({ code: "applied", health: "half_open" });
  return claimed.epoch;
}

async function enterRecovering(scope: RecoveryScope) {
  const epoch = await enterHalfOpen(scope);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const lease = await service.claimHalfOpenTrial({
      scope,
      expectedEpoch: epoch,
      attemptOutcomeId: `attempt-${attempt}`,
      requestId: `request-${attempt}`,
      token: `token-${attempt}`,
      leaseMs: 100,
    });
    expect(isCommandResult(lease)).toBe(false);
    const completed = await service.completeHalfOpenTrial({
      lease: lease as RecoveryTrialLease,
      disposition: "success",
      durationMs: 1,
    });
    expect(completed.code).toBe("applied");
  }
  const state = await service.getState(scope);
  expect(state).toMatchObject({ health: "recovering", recoveryStageIndex: 0 });
  return epoch;
}

beforeAll(async () => {
  await redis.ping();
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

describe("Recovery V2 Redis service", () => {
  test("places every authoritative scope key in one Redis Cluster slot", () => {
    const keys = recoveryScopeKeys({
      kind: "capability",
      providerId: 1,
      modelFamily: "claude-4",
      transport: "https",
    });
    const values = [keys.state, keys.trials, keys.outcomes, keys.window];
    expect(new Set(values.map(redisClusterSlot))).toHaveLength(1);
    expect(new Set(values.map(recoveryRedisHashTag))).toEqual(new Set([keys.scopeHash]));
    expect(redisClusterSlot("foo{bar}one")).toBe(redisClusterSlot("other{bar}two"));
    expect(redisClusterSlot("foo{bar}one")).not.toBe(redisClusterSlot("foo{baz}one"));
  });

  test("initializes, reads, expires, and never overwrites an existing scope", async () => {
    const scope = providerScope(101);
    expect(await service.initializeScope(scope, "closed")).toMatchObject({
      code: "applied",
      epoch: 1,
      health: "closed",
    });
    expect(await service.initializeScope(scope, "open")).toMatchObject({
      code: "exists",
      epoch: 1,
      health: "closed",
    });
    const state = await service.getState(scope);
    expect(state).toMatchObject({
      version: 2,
      health: "closed",
      epoch: 1,
      automationPaused: false,
      trialOccupancy: 0,
    });
    const ttl = await redis.pttl(recoveryScopeKeys(scope).state);
    expect(ttl).toBeGreaterThan(4_000);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  test("enforces live half-open capacity, renewal, expiry, completion, and dedupe", async () => {
    const scope = providerScope(102);
    const epoch = await enterHalfOpen(scope);
    const first = await service.claimHalfOpenTrial({
      scope,
      expectedEpoch: epoch,
      attemptOutcomeId: "attempt-a",
      requestId: "request-a",
      token: "token-a",
      leaseMs: 40,
    });
    expect(isCommandResult(first)).toBe(false);

    const rejected = await service.claimHalfOpenTrial({
      scope,
      expectedEpoch: epoch,
      attemptOutcomeId: "attempt-b",
      requestId: "request-b",
      token: "token-b",
      leaseMs: 40,
    });
    expect(rejected).toMatchObject({ code: "capacity_exhausted" });

    const renewed = await service.renewHalfOpenTrial(first as RecoveryTrialLease, 80);
    expect(isCommandResult(renewed)).toBe(false);
    expect((renewed as RecoveryTrialLease).expiresAt).toBeGreaterThan(
      (first as RecoveryTrialLease).expiresAt
    );
    const completed = await service.completeHalfOpenTrial({
      lease: renewed as RecoveryTrialLease,
      disposition: "success",
      durationMs: 1,
    });
    expect(completed.code).toBe("applied");
    expect(
      await service.completeHalfOpenTrial({
        lease: renewed as RecoveryTrialLease,
        disposition: "success",
        durationMs: 1,
      })
    ).toMatchObject({ code: "duplicate" });

    const expiring = await service.claimHalfOpenTrial({
      scope,
      expectedEpoch: epoch,
      attemptOutcomeId: "attempt-expire",
      requestId: "request-expire",
      token: "token-expire",
      leaseMs: 5,
    });
    expect(isCommandResult(expiring)).toBe(false);
    await wait(15);
    await expect(
      service.releaseHalfOpenTrial(expiring as RecoveryTrialLease)
    ).resolves.toMatchObject({
      code: "lease_not_found",
    });
    expect((await service.getState(scope))?.trialOccupancy).toBe(0);
  });

  test("allows only one concurrent claim and one concurrent settlement", async () => {
    const scope = providerScope(103);
    const epoch = await enterHalfOpen(scope);
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.claimHalfOpenTrial({
          scope,
          expectedEpoch: epoch,
          attemptOutcomeId: `attempt-concurrent-${index}`,
          requestId: `request-concurrent-${index}`,
          token: `token-concurrent-${index}`,
          leaseMs: 100,
        })
      )
    );
    const leases = claims.filter((claim) => !isCommandResult(claim)) as RecoveryTrialLease[];
    expect(leases).toHaveLength(1);
    expect(claims.filter((claim) => isCommandResult(claim))).toHaveLength(7);

    const settlements = await Promise.all([
      service.completeHalfOpenTrial({ lease: leases[0], disposition: "success", durationMs: 1 }),
      service.completeHalfOpenTrial({ lease: leases[0], disposition: "success", durationMs: 1 }),
    ]);
    expect(settlements.map((result) => result.code).sort()).toEqual(["applied", "duplicate"]);
  });

  test("fences stale epochs and safely replays missing multi-scope settlement", async () => {
    const firstScope = providerScope(104);
    const secondScope = providerScope(105);
    await service.initializeScope(firstScope, "closed");
    await service.initializeScope(secondScope, "closed");
    const input = {
      expectedEpoch: 1,
      attemptOutcomeId: "attempt-shared",
      disposition: "success" as const,
      durationMs: 1,
    };
    expect(await service.recordAttemptOutcome({ scope: firstScope, ...input })).toMatchObject({
      code: "applied",
    });
    expect(await service.recordAttemptOutcome({ scope: firstScope, ...input })).toMatchObject({
      code: "duplicate",
    });
    expect(await service.recordAttemptOutcome({ scope: secondScope, ...input })).toMatchObject({
      code: "applied",
    });
    expect(
      await service.recordAttemptOutcome({
        scope: secondScope,
        ...input,
        expectedEpoch: 0,
        attemptOutcomeId: "attempt-stale",
      })
    ).toMatchObject({ code: "stale_epoch", epoch: 1 });
  });

  test("keeps pause orthogonal, accepts stricter failures, and restarts validation on resume", async () => {
    const scope = providerScope(106);
    await service.initializeScope(scope, "closed");
    expect(
      await service.administrate({
        scope,
        action: "pause",
        expectedEpoch: 1,
        reason: "maintenance",
      })
    ).toMatchObject({ code: "applied", epoch: 1, health: "closed" });
    await service.recordAttemptOutcome({
      scope,
      expectedEpoch: 1,
      attemptOutcomeId: "paused-failure-1",
      disposition: "transient_failure",
      durationMs: 1,
    });
    const opened = await service.recordAttemptOutcome({
      scope,
      expectedEpoch: 1,
      attemptOutcomeId: "paused-failure-2",
      disposition: "transient_failure",
      durationMs: 1,
    });
    expect(opened).toMatchObject({ code: "applied", epoch: 2, health: "open" });
    expect(await service.claimPassiveHalfOpen(scope, 2)).toMatchObject({ code: "paused" });
    expect(
      await service.administrate({
        scope,
        action: "resume",
        expectedEpoch: 2,
        reason: "maintenance complete",
      })
    ).toMatchObject({ code: "applied", epoch: 3, health: "open" });
  });

  test("fences probe tokens and a successful probe enters half-open only", async () => {
    const scope = providerScope(107);
    const initialized = await service.initializeScope(scope, "open");
    await wait(7);
    const lease = await service.claimProbe({
      scope,
      expectedEpoch: initialized.epoch,
      leaseMs: 100,
      token: "probe-token",
    });
    expect(isCommandResult(lease)).toBe(false);
    expect(
      await service.completeProbe({
        lease: { ...(lease as Exclude<typeof lease, RecoveryCommandResult>), token: "stale-token" },
        succeeded: true,
        nextProbeDelayMs: 5,
      })
    ).toMatchObject({ code: "stale_token" });
    expect(
      await service.completeProbe({
        lease: lease as Exclude<typeof lease, RecoveryCommandResult>,
        succeeded: true,
        nextProbeDelayMs: 5,
      })
    ).toMatchObject({ code: "applied", health: "half_open" });
    expect((await service.getState(scope))?.health).toBe("half_open");
  });

  test("rejects expired probe completion and permits one reclaim", async () => {
    const scope = providerScope(112);
    const initialized = await service.initializeScope(scope, "open");
    await wait(7);
    const expired = await service.claimProbe({
      scope,
      expectedEpoch: initialized.epoch,
      leaseMs: 5,
      token: "expired-probe",
    });
    expect(isCommandResult(expired)).toBe(false);
    await wait(15);
    expect(
      await service.completeProbe({
        lease: expired as Exclude<typeof expired, RecoveryCommandResult>,
        succeeded: true,
        nextProbeDelayMs: 5,
      })
    ).toMatchObject({ code: "stale_token", health: "probing" });
    const reclaimed = await service.claimProbe({
      scope,
      expectedEpoch: initialized.epoch,
      leaseMs: 50,
      token: "reclaimed-probe",
    });
    expect(isCommandResult(reclaimed)).toBe(false);
    expect(
      await service.completeProbe({
        lease: reclaimed as Exclude<typeof reclaimed, RecoveryCommandResult>,
        succeeded: false,
        nextProbeDelayMs: 10,
      })
    ).toMatchObject({ code: "applied", health: "open", epoch: initialized.epoch + 1 });
  });

  test("hard and unhealthy recovery-window outcomes reopen immediately", async () => {
    const hardScope = providerScope(108);
    await service.initializeScope(hardScope, "closed");
    expect(
      await service.recordAttemptOutcome({
        scope: hardScope,
        expectedEpoch: 1,
        attemptOutcomeId: "hard-failure",
        disposition: "hard_failure",
        durationMs: 1,
      })
    ).toMatchObject({ code: "applied", health: "open", epoch: 2 });

    const slowScope = providerScope(109);
    const epoch = await enterRecovering(slowScope);
    await service.recordAttemptOutcome({
      scope: slowScope,
      expectedEpoch: epoch,
      attemptOutcomeId: "stage-slow-1",
      disposition: "success",
      durationMs: 20,
    });
    expect(
      await service.recordAttemptOutcome({
        scope: slowScope,
        expectedEpoch: epoch,
        attemptOutcomeId: "stage-slow-2",
        disposition: "success",
        durationMs: 20,
      })
    ).toMatchObject({ code: "applied", health: "open", epoch: epoch + 1 });

    const failureScope = providerScope(113);
    const failureEpoch = await enterRecovering(failureScope);
    await service.recordAttemptOutcome({
      scope: failureScope,
      expectedEpoch: failureEpoch,
      attemptOutcomeId: "stage-failure-1",
      disposition: "transient_failure",
      durationMs: 1,
    });
    expect(
      await service.recordAttemptOutcome({
        scope: failureScope,
        expectedEpoch: failureEpoch,
        attemptOutcomeId: "stage-failure-2",
        disposition: "success",
        durationMs: 1,
      })
    ).toMatchObject({ code: "applied", health: "open", epoch: failureEpoch + 1 });
  });

  test("advances every fixed stage only after time and real stage-local outcomes", async () => {
    const scope = providerScope(110);
    const epoch = await enterRecovering(scope);
    expect(
      await service.validateRecoveryAdmission({
        scope,
        expectedEpoch: epoch,
        expectedStageIndex: 0,
        bucket: 499,
      })
    ).toMatchObject({ code: "applied" });
    expect(
      await service.validateRecoveryAdmission({
        scope,
        expectedEpoch: epoch,
        expectedStageIndex: 0,
        bucket: 500,
      })
    ).toMatchObject({ code: "bucket_rejected" });
    expect(await service.advanceRecovery(scope, epoch)).toMatchObject({ code: "not_due" });

    for (let stage = 0; stage < 5; stage += 1) {
      for (let sample = 0; sample < 2; sample += 1) {
        expect(
          await service.recordAttemptOutcome({
            scope,
            expectedEpoch: epoch,
            attemptOutcomeId: `stage-${stage}-sample-${sample}`,
            disposition: "success",
            durationMs: 1,
          })
        ).toMatchObject({ code: "applied" });
      }
      await wait(stage === 3 ? 45 : 25);
      const result = await service.advanceRecovery(scope, epoch);
      expect(result).toMatchObject({
        code: "applied",
        health: stage === 4 ? "closed" : "recovering",
      });
      const state = await service.getState(scope);
      if (stage < 4) expect(state?.recoveryStageIndex).toBe(stage + 1);
    }
    expect(await service.getState(scope)).toMatchObject({
      health: "closed",
      failureCount: 0,
      closedStableAt: expect.any(Number),
    });
  });

  test("safe reset remains OPEN and force-close requires explicit confirmation", async () => {
    const scope = providerScope(111);
    await service.initializeScope(scope, "closed");
    expect(
      await service.administrate({
        scope,
        action: "reset",
        expectedEpoch: 1,
        reason: "compatibility reset",
      })
    ).toMatchObject({ code: "applied", health: "open", epoch: 2 });
    expect(
      await service.administrate({
        scope,
        action: "force_close",
        expectedEpoch: 2,
        reason: "manual recovery",
      })
    ).toMatchObject({ code: "confirmation_required", health: "open", epoch: 2 });
    expect(
      await service.administrate({
        scope,
        action: "force_close",
        expectedEpoch: 2,
        reason: "manual recovery",
        confirmation: "FORCE_CLOSE",
      })
    ).toMatchObject({ code: "applied", health: "closed", epoch: 3 });
  });
});
