import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CODE_PROBE_BUDGET_DEFAULTS, CODE_RECOVERY_DEFAULTS } from "@/lib/recovery/config";
import { RecoveryDegradationGate, RecoveryDegradedReconciler } from "@/lib/recovery/degradation";
import { FailbackSemaphore } from "@/lib/recovery/failback";
import {
  commitStreamingMigrationResponse,
  containsCompleteSseEvent,
} from "@/lib/recovery/failback-commit";
import { RecoveryDueScheduler } from "@/lib/recovery/probe-scheduler";
import { hashRecoveryScope } from "@/lib/recovery/scope";
import { RecoveryStrictnessCache } from "@/lib/recovery/strictness-cache";
import { RecoveryV2Service } from "@/lib/redis/recovery-v2-service";
import { SessionBindingV2Service } from "@/lib/redis/session-binding-v2-service";
import type { RecoveryScope } from "@/lib/recovery/contracts";

const redis = new Redis(process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379", {
  maxRetriesPerRequest: 1,
  db: 13,
});
const settings = { ...CODE_RECOVERY_DEFAULTS, openDurationMs: 5, stateRetentionMs: 5_000 };
const service = new RecoveryV2Service(redis, settings);
const scope = (providerId: number): RecoveryScope => ({ kind: "provider", providerId });
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const reconnect = async (client: Redis) => {
  if (client.status === "end") await client.connect();
  if (client.status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
    });
  }
};

beforeAll(async () => {
  await redis.ping();
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe("multi-instance recovery orchestration", () => {
  test("allows one effective probe across two schedulers and enters half-open only", async () => {
    const target = scope(501);
    await service.initializeScope(target, "open");
    await wait(8);
    const execute = vi.fn(async () => ({ succeeded: true, costUsd: 0 }));
    const budgets = { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe", timeoutMs: 20 };
    const first = new RecoveryDueScheduler(redis, service, budgets, execute, {
      leaderLeaseMs: 100,
    });
    const second = new RecoveryDueScheduler(redis, service, budgets, execute, {
      leaderLeaseMs: 100,
    });
    await first.schedule(target, Date.now() - 1);
    await Promise.all([first.tick(), second.tick()]);
    expect(execute).toHaveBeenCalledOnce();
    expect(await service.getState(target)).toMatchObject({ health: "half_open" });
  });

  test("rebuilds a missing due member and removes a stale member", async () => {
    const target = scope(502);
    await service.initializeScope(target, "open");
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe" },
      vi.fn()
    );
    expect((await scheduler.reconcile()).repaired).toBe(1);
    expect(await redis.zcard("cb:v2:recovery_due")).toBe(1);
    await service.administrate({
      scope: target,
      action: "force_close",
      expectedEpoch: 1,
      reason: "verified",
      confirmation: "FORCE_CLOSE",
    });
    await scheduler.reconcile();
    expect(await redis.zcard("cb:v2:recovery_due")).toBe(0);
  });

  test("respects safe-model and RPM budget exhaustion", async () => {
    const disabled = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: null },
      vi.fn()
    );
    expect(await disabled.tick()).toBe(0);
    const execute = vi.fn(async () => ({ succeeded: false, costUsd: null }));
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe", requestsPerMinute: 1, timeoutMs: 10 },
      execute,
      { leaderLeaseMs: 10 }
    );
    for (const id of [503, 504]) {
      await service.initializeScope(scope(id), "open");
      await scheduler.schedule(scope(id), Date.now() - 1);
    }
    await wait(8);
    expect(await scheduler.tick()).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  test("settles actual probe cost and blocks the remaining daily budget", async () => {
    const execute = vi.fn(async () => ({ succeeded: false, costUsd: 2 }));
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      {
        ...CODE_PROBE_BUDGET_DEFAULTS,
        safeModel: "safe",
        dailyCostUsd: 1,
        requestsPerMinute: 10,
        timeoutMs: 10,
      },
      execute,
      { leaderLeaseMs: 100 }
    );
    for (const id of [508, 509]) {
      await service.initializeScope(scope(id), "open");
      await scheduler.schedule(scope(id), Date.now() - 1);
    }
    await wait(8);
    expect(await scheduler.tick()).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(await redis.zcard("cb:v2:recovery_due")).toBe(1);
  });

  test("recovers an expired global failback lease", async () => {
    const first = new FailbackSemaphore(redis);
    const second = new FailbackSemaphore(redis);
    const lease = await first.claim(1, 5, "first");
    expect(lease).not.toBeNull();
    expect(await second.claim(1, 50, "second")).toBeNull();
    await wait(8);
    const recovered = await second.claim(1, 50, "second");
    expect(recovered?.token).toBe("second");
    await second.release(recovered!);
  });

  test("reclaims an expired probe after a worker dies during dispatch", async () => {
    const target = scope(505);
    await service.initializeScope(target, "open");
    await wait(8);
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker terminated"))
      .mockResolvedValueOnce({ succeeded: true, costUsd: 0 });
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe", timeoutMs: 100 },
      execute,
      { leaderLeaseMs: 5, reservedCostUsd: 0 }
    );
    await scheduler.schedule(target, Date.now() - 1);

    await expect(scheduler.tick()).rejects.toThrow("worker terminated");
    expect(await service.getState(target)).toMatchObject({ health: "probing" });
    await wait(1_110);
    expect(await service.getState(target)).toMatchObject({ health: "open" });
    await wait(8);
    expect(await scheduler.tick()).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await service.getState(target)).toMatchObject({ health: "half_open" });
  });

  test("stops dispatching when scheduler leadership is lost", async () => {
    const targets = [scope(506), scope(507)];
    for (const target of targets) {
      await service.initializeScope(target, "open");
    }
    await wait(8);
    const execute = vi.fn(async () => {
      await redis.del("cb:v2:recovery_due:leader");
      return { succeeded: false, costUsd: null };
    });
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe", timeoutMs: 5 },
      execute,
      { leaderLeaseMs: 100 }
    );
    for (const target of targets) await scheduler.schedule(target, Date.now() - 1);

    expect(await scheduler.tick()).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(await redis.zcard("cb:v2:recovery_due")).toBe(1);
  });

  test("recovers final settlement after Redis disconnect without duplicating the outcome", async () => {
    const isolatedRedis = new Redis(
      process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379",
      { maxRetriesPerRequest: 0, db: 13 }
    );
    const isolatedService = new RecoveryV2Service(isolatedRedis, settings);
    const target = scope(510);
    await isolatedService.initializeScope(target, "closed");
    const snapshot = await isolatedService.getState(target);
    isolatedRedis.disconnect();
    await expect(
      isolatedService.recordAttemptOutcome({
        scope: target,
        expectedEpoch: snapshot!.epoch,
        attemptOutcomeId: "disconnect-final-settlement",
        disposition: "success",
        durationMs: 1,
      })
    ).rejects.toThrow();
    await reconnect(isolatedRedis);
    expect(
      await isolatedService.recordAttemptOutcome({
        scope: target,
        expectedEpoch: snapshot!.epoch,
        attemptOutcomeId: "disconnect-final-settlement",
        disposition: "success",
        durationMs: 1,
      })
    ).toMatchObject({ code: "applied" });
    expect(
      await isolatedService.recordAttemptOutcome({
        scope: target,
        expectedEpoch: snapshot!.epoch,
        attemptOutcomeId: "disconnect-final-settlement",
        disposition: "success",
        durationMs: 1,
      })
    ).toMatchObject({ code: "duplicate" });
    await isolatedRedis.quit();
  });

  test("fences binding commit across disconnect and renews migration ownership", async () => {
    const isolatedRedis = new Redis(
      process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379",
      { maxRetriesPerRequest: 0, db: 13 }
    );
    const bindings = new SessionBindingV2Service(isolatedRedis, 60_000, "v2_only");
    const created = await bindings.create({
      sessionId: "disconnect-binding",
      providerId: 2,
      keyId: 1,
      effectivePriority: 2,
    });
    const prepared = await bindings.prepareMigration({
      sessionId: "disconnect-binding",
      expectedGeneration: created.binding!.generation,
      providerId: 1,
      keyId: 1,
      leaseMs: 5_000,
      attemptOutcomeId: "binding-boundary",
    });
    expect(prepared.code).toBe("applied");
    expect(
      await bindings.renewMigration({
        sessionId: "disconnect-binding",
        generation: created.binding!.generation,
        token: prepared.token,
        leaseMs: 5_000,
      })
    ).toMatchObject({ code: "applied" });
    isolatedRedis.disconnect();
    await expect(
      bindings.renewMigration({
        sessionId: "disconnect-binding",
        generation: created.binding!.generation,
        token: prepared.token,
        leaseMs: 5_000,
      })
    ).rejects.toThrow();
    await reconnect(isolatedRedis);
    expect(
      await bindings.renewMigration({
        sessionId: "disconnect-binding",
        generation: created.binding!.generation,
        token: prepared.token,
        leaseMs: 5_000,
      })
    ).toMatchObject({ code: "applied" });
    isolatedRedis.disconnect();
    await expect(
      bindings.commitMigration({
        sessionId: "disconnect-binding",
        expectedGeneration: created.binding!.generation,
        token: prepared.token,
        effectivePriority: 0,
      })
    ).rejects.toThrow();
    await reconnect(isolatedRedis);
    expect(
      await bindings.commitMigration({
        sessionId: "disconnect-binding",
        expectedGeneration: created.binding!.generation,
        token: prepared.token,
        effectivePriority: 0,
      })
    ).toMatchObject({ code: "applied" });
    await isolatedRedis.quit();
  });

  test("keeps the first valid stream event private across binding commit disconnects", async () => {
    const failedRedis = new Redis(
      process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379",
      { maxRetriesPerRequest: 0, db: 13 }
    );
    const failedBindings = new SessionBindingV2Service(failedRedis, 60_000, "v2_only");
    const createPrepared = async (bindings: SessionBindingV2Service, sessionId: string) => {
      const created = await bindings.create({
        sessionId,
        providerId: 2,
        keyId: 1,
        effectivePriority: 2,
      });
      const prepared = await bindings.prepareMigration({
        sessionId,
        expectedGeneration: created.binding!.generation,
        providerId: 1,
        keyId: 1,
        leaseMs: 5_000,
        attemptOutcomeId: `${sessionId}-attempt`,
      });
      return { created, prepared };
    };

    const failed = await createPrepared(failedBindings, "stream-commit-failed");
    failedRedis.disconnect();
    const unavailable = await commitStreamingMigrationResponse({
      upstream: new Response("data: private-before-commit\n\n"),
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: {
        commit: () =>
          failedBindings.commitMigration({
            sessionId: "stream-commit-failed",
            expectedGeneration: failed.created.binding!.generation,
            token: failed.prepared.token,
            effectivePriority: 0,
          }),
      },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private-before-commit");

    const successRedis = new Redis(
      process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379",
      { maxRetriesPerRequest: 0, db: 13 }
    );
    const successBindings = new SessionBindingV2Service(successRedis, 60_000, "v2_only");
    const committed = await createPrepared(successBindings, "stream-commit-succeeded");
    const response = await commitStreamingMigrationResponse({
      upstream: new Response("data: first-client-byte\n\n"),
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: {
        commit: async () => {
          const result = await successBindings.commitMigration({
            sessionId: "stream-commit-succeeded",
            expectedGeneration: committed.created.binding!.generation,
            token: committed.prepared.token,
            effectivePriority: 0,
          });
          successRedis.disconnect();
          return result;
        },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("first-client-byte");
    const inspectorRedis = new Redis(
      process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379",
      { maxRetriesPerRequest: 0, db: 13 }
    );
    const inspector = new SessionBindingV2Service(inspectorRedis, 60_000, "v2_only");
    expect(await inspector.get("stream-commit-succeeded")).toMatchObject({
      binding: { state: "stable", providerId: 1 },
    });
    await inspectorRedis.quit();
  });

  test("does not clear degraded mode when Redis disconnects during fresh reconciliation", async () => {
    const isolatedRedis = new Redis(
      process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379",
      { maxRetriesPerRequest: 0, db: 13 }
    );
    const isolatedService = new RecoveryV2Service(isolatedRedis, settings);
    const target = scope(511);
    await isolatedService.initializeScope(target, "closed");
    const gate = new RecoveryDegradationGate(
      new RecoveryStrictnessCache(),
      { upsert: async () => undefined },
      "integration"
    );
    gate.enter();
    let disconnectVerifier = true;
    const reconciler = new RecoveryDegradedReconciler(
      {
        list: async () => [
          {
            scopeHash: hashRecoveryScope(target),
            scope: target,
            failureClass: "upstream",
          },
        ],
        markReconciled: async (hashes) => hashes.length,
      },
      isolatedService,
      gate,
      async () => {
        if (disconnectVerifier) {
          disconnectVerifier = false;
          isolatedRedis.disconnect();
        }
        await isolatedService.getState(target);
      }
    );

    await expect(reconciler.reconcile()).rejects.toThrow();
    expect(gate.clearAfterFreshAuthorityRead()).toBe(false);
    expect(gate.degraded).toBe(true);
    await reconnect(isolatedRedis);
    await reconciler.reconcile();
    expect(gate.clearAfterFreshAuthorityRead()).toBe(true);
    await isolatedRedis.quit();
  });
});
