import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { credentialFingerprint, ProviderLimitService } from "@/lib/recovery/provider-limit";

const redis = new Redis(process.env.RECOVERY_TEST_REDIS_URL ?? "redis://127.0.0.1:46379", {
  maxRetriesPerRequest: 1,
  db: 14,
});
const service = new ProviderLimitService(redis, 100);
const scope = { providerId: 88, credentialFingerprint: credentialFingerprint("secret-credential") };

beforeAll(async () => {
  await redis.ping();
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

describe("provider credential cooldown", () => {
  test("honors the longest Retry-After and expires independently", async () => {
    const first = await service.applyCooldown({ scope, retryAfterMs: 100, reason: "upstream_429" });
    const shorter = await service.applyCooldown({
      scope,
      retryAfterMs: 10,
      reason: "upstream_429",
    });
    expect(shorter.blockedUntil).toBe(first.blockedUntil);
    expect(await service.getCooldown(scope)).toMatchObject({
      blocked: true,
      blockedUntil: first.blockedUntil,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await service.getCooldown(scope)).toMatchObject({ blocked: false, blockedUntil: null });
  });
});
