import { describe, expect, it, vi } from "vitest";
import {
  bindingResultOrThrow,
  bindingV2IsAuthoritative,
  getSessionBindingRuntime,
  SessionBindingUnavailableError,
  SessionMigrationInProgressError,
  setSessionBindingRuntime,
} from "@/lib/recovery/binding-authority";
import { RecoveryCompatibilityFacade } from "@/lib/recovery/compatibility-facade";
import { createAttemptIdentity } from "@/lib/recovery/attempt-identity";
import {
  credentialFingerprint,
  ProviderLimitService,
  providerLimitKey,
} from "@/lib/recovery/provider-limit";

const scope = { kind: "provider" as const, providerId: 7 };

describe("recovery external adapters", () => {
  it("maps binding authority results and typed availability errors", () => {
    const runtime = { mode: "v2_only" as const, production: {} as any, shadow: null };
    setSessionBindingRuntime(runtime);
    expect(getSessionBindingRuntime()).toBe(runtime);
    expect(bindingV2IsAuthoritative("legacy")).toBe(false);
    expect(bindingV2IsAuthoritative("shadow")).toBe(false);
    expect(bindingV2IsAuthoritative("v2_dual_write")).toBe(true);
    expect(bindingV2IsAuthoritative("v2_only")).toBe(true);
    expect(bindingResultOrThrow({ code: "not_found" })).toBeNull();
    const binding = { generation: 1 } as any;
    expect(bindingResultOrThrow({ code: "applied", binding })).toBe(binding);
    expect(() => bindingResultOrThrow({ code: "stale_generation" } as any)).toThrow(
      SessionBindingUnavailableError
    );
    expect(new SessionMigrationInProgressError().code).toBe("session_migration_in_progress");
  });

  it("mirrors each shadow outcome scope once and initializes missing state", async () => {
    const production = {
      getState: vi.fn(),
      initializeScope: vi.fn(),
      recordAttemptOutcome: vi.fn(),
    };
    const shadow = {
      getState: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ health: "closed", epoch: 2 }),
      initializeScope: vi.fn(async () => ({ code: "applied" })),
      recordAttemptOutcome: vi.fn(async () => ({ code: "applied" })),
    };
    const facade = new RecoveryCompatibilityFacade("shadow", production, shadow);
    const outcome = {
      scope,
      disposition: "success" as const,
      identity: createAttemptIdentity("request", 1, "primary", () => "outcome"),
      durationMs: 10,
    };
    await facade.mirrorOutcome(outcome);
    await facade.mirrorOutcome(outcome);
    expect(shadow.initializeScope).toHaveBeenCalledOnce();
    expect(shadow.recordAttemptOutcome).toHaveBeenCalledOnce();
    expect(production.getState).not.toHaveBeenCalled();

    const legacy = new RecoveryCompatibilityFacade("legacy", production, shadow);
    await legacy.mirrorOutcome(outcome);
    expect(await legacy.isOpen(scope, "unknown")).toBe(true);
    legacy.recordRoutingDecision({
      scopes: [{ scope, health: "closed", basisPoints: 10_000 }],
      legacyAllowed: true,
      v2Allowed: true,
    });
    expect(legacy.shadowDiffs.drain()).toEqual([]);
  });

  it("validates provider-limit identities and maps Redis-time cooldowns", async () => {
    const fingerprint = credentialFingerprint("credential");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(providerLimitKey({ providerId: 7, credentialFingerprint: fingerprint })).toContain(
      `{7:${fingerprint}}`
    );
    expect(() => credentialFingerprint("")).toThrow("non-empty");
    expect(() => providerLimitKey({ providerId: 0, credentialFingerprint: fingerprint })).toThrow(
      "positive safe integer"
    );
    expect(() => providerLimitKey({ providerId: 7, credentialFingerprint: "raw-secret" })).toThrow(
      "SHA-256"
    );

    const redis = {
      eval: vi
        .fn()
        .mockResolvedValueOnce([2_000, 1_000])
        .mockResolvedValueOnce([2_000, 1_000])
        .mockResolvedValueOnce([0, 3_000]),
    };
    const service = new ProviderLimitService(redis, 5_000);
    expect(
      await service.applyCooldown({
        scope: { providerId: 7, credentialFingerprint: fingerprint },
        retryAfterMs: 1_000.9,
        reason: " rate_limit ",
      })
    ).toEqual({ blockedUntil: 2_000, redisTimeMs: 1_000 });
    expect(
      await service.getCooldown({ providerId: 7, credentialFingerprint: fingerprint })
    ).toEqual({ blocked: true, blockedUntil: 2_000, redisTimeMs: 1_000 });
    expect(
      await service.getCooldown({ providerId: 7, credentialFingerprint: fingerprint })
    ).toEqual({ blocked: false, blockedUntil: null, redisTimeMs: 3_000 });
    await expect(
      service.applyCooldown({
        scope: { providerId: 7, credentialFingerprint: fingerprint },
        retryAfterMs: 1,
        reason: " ",
      })
    ).rejects.toThrow("bounded");
    await expect(
      new ProviderLimitService({ eval: async () => "bad" }).getCooldown({
        providerId: 7,
        credentialFingerprint: fingerprint,
      })
    ).rejects.toThrow("numeric pair");
  });
});
