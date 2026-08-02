import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionBindingV2Service } from "@/lib/redis/session-binding-v2-service";
import { sessionBindingV2Keys } from "@/lib/redis/session-binding-v2-keys";

const redis = new Redis(process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379", {
  maxRetriesPerRequest: 1,
  db: 12,
});
const service = new SessionBindingV2Service(redis, 5_000, "v2_dual_write");

beforeAll(async () => {
  await redis.ping();
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe("Session Binding V2", () => {
  test("creates generation one and dual-writes same-session scalar keys", async () => {
    const created = await service.create({
      sessionId: "create",
      providerId: 4,
      keyId: 9,
      effectivePriority: 2,
    });
    expect(created).toMatchObject({
      code: "applied",
      binding: { generation: 1, providerId: 4, keyId: 9, state: "stable" },
    });
    expect(
      (
        await service.create({
          sessionId: "create",
          providerId: 5,
          keyId: null,
          effectivePriority: 1,
        })
      ).code
    ).toBe("exists");
    const keys = sessionBindingV2Keys("create", 1);
    expect(await redis.mget(keys.providerCompatibility, keys.keyCompatibility)).toEqual(["4", "9"]);
  });

  test("fences route leases by generation and token and renews sliding TTL", async () => {
    await service.create({ sessionId: "route", providerId: 1, keyId: 2, effectivePriority: 3 });
    const claim = await service.claimRoute({
      sessionId: "route",
      generation: 1,
      leaseMs: 100,
      token: "route-token",
    });
    expect(claim.code).toBe("applied");
    expect(
      (
        await service.renewRoute({
          sessionId: "route",
          generation: 1,
          token: "wrong",
          leaseMs: 100,
        })
      ).code
    ).toBe("stale_token");
    expect(
      (
        await service.renewRoute({
          sessionId: "route",
          generation: 1,
          token: "route-token",
          leaseMs: 200,
        })
      ).code
    ).toBe("applied");
    expect(
      (await service.releaseRoute({ sessionId: "route", generation: 1, token: "route-token" })).code
    ).toBe("applied");
  });

  test("preserves first failover origin across multiple hops", async () => {
    await service.create({ sessionId: "failover", providerId: 1, keyId: 2, effectivePriority: 0 });
    const first = await service.commitRoute({
      sessionId: "failover",
      expectedGeneration: 1,
      providerId: 2,
      keyId: 2,
      effectivePriority: 1,
      reason: "failover",
    });
    expect(first.binding).toMatchObject({
      generation: 2,
      providerId: 2,
      failedOverFromProviderId: 1,
      failedOverFromPriority: 0,
    });
    const second = await service.commitRoute({
      sessionId: "failover",
      expectedGeneration: 2,
      providerId: 3,
      keyId: 2,
      effectivePriority: 2,
      reason: "failover",
    });
    expect(second.binding).toMatchObject({
      generation: 3,
      providerId: 3,
      failedOverFromProviderId: 1,
      failedOverFromPriority: 0,
    });
    expect(
      (
        await service.commitRoute({
          sessionId: "failover",
          expectedGeneration: 1,
          providerId: 4,
          keyId: null,
          effectivePriority: 3,
          reason: "race_winner",
        })
      ).code
    ).toBe("stale_generation");
  });

  test("migration ownership excludes live routes and commits through matching token", async () => {
    await service.create({ sessionId: "migration", providerId: 2, keyId: 8, effectivePriority: 2 });
    await service.claimRoute({
      sessionId: "migration",
      generation: 1,
      leaseMs: 500,
      token: "active",
    });
    expect(
      (
        await service.prepareMigration({
          sessionId: "migration",
          expectedGeneration: 1,
          providerId: 1,
          keyId: 8,
          leaseMs: 100,
          attemptOutcomeId: "attempt",
          token: "migration-token",
        })
      ).code
    ).toBe("session_busy");
    await service.releaseRoute({ sessionId: "migration", generation: 1, token: "active" });
    const prepared = await service.prepareMigration({
      sessionId: "migration",
      expectedGeneration: 1,
      providerId: 1,
      keyId: 8,
      leaseMs: 100,
      attemptOutcomeId: "attempt",
      token: "migration-token",
    });
    expect(prepared.binding).toMatchObject({ state: "migrating", pendingProviderId: 1 });
    expect(
      (
        await service.commitMigration({
          sessionId: "migration",
          expectedGeneration: 1,
          token: "wrong",
          effectivePriority: 0,
        })
      ).code
    ).toBe("stale_token");
    const committed = await service.commitMigration({
      sessionId: "migration",
      expectedGeneration: 1,
      token: "migration-token",
      effectivePriority: 0,
    });
    expect(committed.binding).toMatchObject({
      state: "stable",
      generation: 2,
      providerId: 1,
      bindingReason: "failback",
      failedOverFromProviderId: null,
    });
  });

  test("recovers an expired migration lease conservatively", async () => {
    await service.create({
      sessionId: "expired",
      providerId: 2,
      keyId: null,
      effectivePriority: 2,
    });
    await service.prepareMigration({
      sessionId: "expired",
      expectedGeneration: 1,
      providerId: 1,
      keyId: null,
      leaseMs: 5,
      attemptOutcomeId: "attempt",
      token: "token",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await service.get("expired")).binding).toMatchObject({
      state: "stable",
      providerId: 2,
      generation: 1,
    });
  });

  test("keeps shadow namespace isolated", async () => {
    const shadow = new SessionBindingV2Service(redis, 5_000, "shadow", "shadow");
    await shadow.create({ sessionId: "shadow", providerId: 7, keyId: null, effectivePriority: 0 });
    expect((await service.get("shadow")).code).toBe("not_found");
    expect((await shadow.get("shadow")).binding?.providerId).toBe(7);
  });

  test("renews migration ownership and applies cooldown only after abort", async () => {
    await service.create({
      sessionId: "migration-renew",
      providerId: 2,
      keyId: null,
      effectivePriority: 2,
    });
    const prepared = await service.prepareMigration({
      sessionId: "migration-renew",
      expectedGeneration: 1,
      providerId: 1,
      keyId: null,
      leaseMs: 50,
      attemptOutcomeId: "attempt-renew",
      token: "migration-renew-token",
    });
    expect(
      (
        await service.renewMigration({
          sessionId: "migration-renew",
          generation: 1,
          token: "wrong",
          leaseMs: 500,
        })
      ).code
    ).toBe("stale_token");
    expect(
      (
        await service.renewMigration({
          sessionId: "migration-renew",
          generation: 1,
          token: prepared.token,
          leaseMs: 500,
        })
      ).code
    ).toBe("applied");
    expect(
      (
        await service.abortMigration({
          sessionId: "migration-renew",
          expectedGeneration: 1,
          token: prepared.token,
          cooldownMs: 1_000,
        })
      ).binding
    ).toMatchObject({
      state: "stable",
      providerId: 2,
      generation: 1,
      failbackCooldownUntil: expect.any(Number),
    });
  });

  test("v2-only authority never writes compatibility scalar keys", async () => {
    const v2Only = new SessionBindingV2Service(redis, 5_000, "v2_only");
    await v2Only.create({
      sessionId: "v2-only",
      providerId: 9,
      keyId: 11,
      effectivePriority: 0,
    });
    const keys = sessionBindingV2Keys("v2-only", 1);
    expect(await redis.mget(keys.providerCompatibility, keys.keyCompatibility)).toEqual([
      null,
      null,
    ]);
    expect((await v2Only.get("v2-only")).binding).toMatchObject({
      providerId: 9,
      keyId: 11,
      generation: 1,
    });
  });
});
