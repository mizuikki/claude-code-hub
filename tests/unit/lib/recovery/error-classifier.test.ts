import { describe, expect, test } from "vitest";
import type { EndpointRecoveryPolicy } from "@/lib/recovery/contracts";
import { classifyRecoveryEffects } from "@/lib/recovery/error-classifier";
import { deriveRecoveryScopes } from "@/lib/recovery/scope-derivation";

const businessPolicy: EndpointRecoveryPolicy = {
  recoveryEvidence: "business",
  halfOpenEligible: true,
  retrySafety: "pre_commit_only",
  migrationSafety: "replayable",
  trackSessionBinding: true,
};

const scopes = deriveRecoveryScopes({
  vendorId: 7,
  providerId: 11,
  providerType: "claude",
  endpoint: { kind: "managed", endpointId: 13 },
  modelFamily: "claude-sonnet",
  transport: "http",
  policy: businessPolicy,
});

const base = {
  policy: businessPolicy,
  scopes,
  providerLimitScope: { providerId: 11, credentialFingerprint: "credential-hash" },
  reason: "classified",
} as const;

describe("recovery multi-effect classifier", () => {
  test("isolates endpoint connectivity from provider and capability state", () => {
    const result = classifyRecoveryEffects({ ...base, faultClass: "endpoint_connectivity" });

    expect(result.providerLimit).toBeNull();
    expect(result.effects).toEqual([
      { scope: scopes.endpoint, disposition: "transient_failure", reason: "classified" },
    ]);
  });

  test("applies 429 only to credential cooldown", () => {
    const result = classifyRecoveryEffects({
      ...base,
      faultClass: "rate_limit",
      retryAfterMs: 45_000,
    });

    expect(result.effects).toEqual([]);
    expect(result.providerLimit).toEqual({
      disposition: "cooldown",
      scope: base.providerLimitScope,
      retryAfterMs: 45_000,
      reason: "classified",
    });
  });

  test("business success settles every derived scope", () => {
    const result = classifyRecoveryEffects({ ...base, faultClass: "success" });

    expect(result.effects.map((effect) => effect.scope)).toEqual(scopes.ordered);
    expect(result.effects.every((effect) => effect.disposition === "success")).toBe(true);
  });

  test("vendor transport affects only vendor and endpoint scopes", () => {
    const result = classifyRecoveryEffects({
      ...base,
      faultClass: "vendor_transport",
      hard: true,
    });

    expect(result.effects).toEqual([
      { scope: scopes.vendorType, disposition: "hard_failure", reason: "classified" },
      { scope: scopes.endpoint, disposition: "hard_failure", reason: "classified" },
    ]);
  });

  test.each(["client", "local"] as const)("%s failures do not mutate recovery", (faultClass) => {
    expect(classifyRecoveryEffects({ ...base, faultClass })).toEqual({
      effects: [],
      providerLimit: null,
    });
  });
});
