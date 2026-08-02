import {
  classifyRecoveryEffects,
  credentialFingerprint,
  deriveRecoveryScopes,
  providerLimitKey,
  RecoveryStrictnessCache,
  type EndpointRecoveryPolicy,
} from "@/lib/recovery";

const businessPolicy: EndpointRecoveryPolicy = {
  recoveryEvidence: "business",
  halfOpenEligible: true,
  retrySafety: "pre_commit_only",
  migrationSafety: "replayable",
  trackSessionBinding: true,
};

const scopes = deriveRecoveryScopes({
  vendorId: 3,
  providerId: 7,
  providerType: "Claude",
  endpoint: { kind: "managed", endpointId: 11 },
  modelFamily: "claude-4",
  transport: "https",
  policy: businessPolicy,
});
const providerLimitScope = {
  providerId: 7,
  credentialFingerprint: credentialFingerprint("provider-secret"),
};

describe("recovery scope derivation and classification", () => {
  test("derives scopes in the fixed composite-claim order", () => {
    expect(scopes.ordered.map((scope) => scope.kind)).toEqual([
      "vendor-type",
      "provider",
      "endpoint",
      "capability",
    ]);
  });

  test("does not let connectivity success restore provider or capability state", () => {
    const result = classifyRecoveryEffects({
      faultClass: "success",
      policy: { ...businessPolicy, recoveryEvidence: "connectivity" },
      scopes,
      providerLimitScope,
      reason: "connected",
    });
    expect(result.effects).toEqual([
      { scope: scopes.endpoint, disposition: "success", reason: "connected" },
    ]);
  });

  test("attributes explicit fault classes only to their owned scopes", () => {
    expect(
      classifyRecoveryEffects({
        faultClass: "endpoint_connectivity",
        policy: businessPolicy,
        scopes,
        providerLimitScope,
        reason: "connect_timeout",
      }).effects.map((effect) => effect.scope.kind)
    ).toEqual(["endpoint"]);
    expect(
      classifyRecoveryEffects({
        faultClass: "vendor_transport",
        policy: businessPolicy,
        scopes,
        providerLimitScope,
        reason: "tls_failure",
      }).effects.map((effect) => effect.scope.kind)
    ).toEqual(["vendor-type", "endpoint"]);
    expect(
      classifyRecoveryEffects({
        faultClass: "capability",
        policy: businessPolicy,
        scopes,
        providerLimitScope,
        reason: "model_failure",
        hard: true,
      }).effects
    ).toEqual([{ scope: scopes.capability, disposition: "hard_failure", reason: "model_failure" }]);
    expect(
      classifyRecoveryEffects({
        faultClass: "client",
        policy: businessPolicy,
        scopes,
        providerLimitScope,
        reason: "client_cancelled",
      }).effects
    ).toEqual([]);
  });

  test("keeps HTTP 429 cooldown separate from recovery counters", () => {
    const result = classifyRecoveryEffects({
      faultClass: "rate_limit",
      policy: businessPolicy,
      scopes,
      providerLimitScope,
      retryAfterMs: 12_345,
      reason: "upstream_429",
    });
    expect(result.effects).toEqual([]);
    expect(result.providerLimit).toEqual({
      disposition: "cooldown",
      scope: providerLimitScope,
      retryAfterMs: 12_345,
      reason: "upstream_429",
    });
  });

  test("fingerprints credentials without putting secrets in Redis keys", () => {
    const key = providerLimitKey(providerLimitScope);
    expect(key).toMatch(/^cb:v2:provider_limit:\{7:[a-f0-9]{64}\}$/);
    expect(key).not.toContain("provider-secret");
  });
});

describe("strictness-only recovery cache", () => {
  test("accepts authoritative updates but local evidence can only mark OPEN", () => {
    const cache = new RecoveryStrictnessCache();
    const scope = { kind: "provider" as const, providerId: 7 };
    expect(cache.putAuthoritative(scope, "closed", 2, 100)).toBe(true);
    expect(cache.markOpen(scope, 2, 110)).toBe(true);
    expect(cache.get(scope)).toMatchObject({ health: "open", epoch: 2 });
    expect(cache.putAuthoritative(scope, "closed", 1, 120)).toBe(false);
    expect(cache.get(scope)?.health).toBe("open");
  });

  test("permits degraded routing only from CLOSED evidence cached before outage", () => {
    const cache = new RecoveryStrictnessCache();
    const before = { kind: "provider" as const, providerId: 1 };
    const after = { kind: "provider" as const, providerId: 2 };
    const unknown = { kind: "provider" as const, providerId: 3 };
    cache.putAuthoritative(before, "closed", 1, 100);
    cache.putAuthoritative(after, "closed", 1, 201);
    expect(cache.canRouteWhileDegraded(before, 200)).toBe(true);
    expect(cache.canRouteWhileDegraded(after, 200)).toBe(false);
    expect(cache.canRouteWhileDegraded(unknown, 200)).toBe(false);
  });
});
