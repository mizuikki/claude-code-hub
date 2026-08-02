import {
  ATTEMPT_KINDS,
  BUCKET_REJECTION_LIMIT,
  FAILBACK_SKIP_REASONS,
  MIGRATION_SAFETY_VALUES,
  RECOVERY_AUTHORITY_MODES,
  RECOVERY_DISPOSITIONS,
  RECOVERY_EVIDENCE_CLASSES,
  RECOVERY_HEALTH_VALUES,
  RECOVERY_OPERATION_REJECTION_CODES,
  RECOVERY_STAGES,
  RETRY_SAFETY_VALUES,
  SESSION_BINDING_AUTHORITY_MODES,
  SESSION_FAILBACK_MODES,
  bucket10000,
  bucket10000WithDigest,
  canonicalizeDirectEndpoint,
  canonicalizeRecoveryScope,
  compareRecoveryScopes,
  createAttemptIdentity,
  createRequestId,
  failbackRolloutBasisPoints,
  fingerprintDirectEndpoint,
  hashRecoveryScope,
  isBasisPointBucketAdmitted,
  minimumRecoveryStageDurationMs,
  normalizeRecoveryIdentifier,
  recoveryLayerBucket,
  recoveryStageAt,
  resolveFailbackMode,
  resolveRecoverySetting,
  sessionFailbackBucket,
  sortRecoveryScopes,
  type RecoveryScope,
} from "@/lib/recovery";

function uint32Digest(...values: number[]): Uint8Array {
  const result = new Uint8Array(values.length * 4);
  const view = new DataView(result.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return result;
}

describe("recovery contracts", () => {
  test("exports the complete bounded contract values", () => {
    expect(RECOVERY_HEALTH_VALUES).toEqual([
      "closed",
      "open",
      "probing",
      "half_open",
      "recovering",
    ]);
    expect(RECOVERY_AUTHORITY_MODES).toEqual(["legacy", "shadow", "enforce"]);
    expect(SESSION_BINDING_AUTHORITY_MODES).toEqual([
      "legacy",
      "shadow",
      "v2_dual_write",
      "v2_only",
    ]);
    expect(SESSION_FAILBACK_MODES).toEqual(["sticky", "safe_auto"]);
    expect(RECOVERY_EVIDENCE_CLASSES).toEqual(["none", "connectivity", "business"]);
    expect(MIGRATION_SAFETY_VALUES).toEqual(["replayable", "provider_bound", "unknown"]);
    expect(RETRY_SAFETY_VALUES).toEqual(["pre_commit_only", "idempotent", "never"]);
    expect(ATTEMPT_KINDS).toEqual(["primary", "retry", "race", "probe", "failback"]);
    expect(RECOVERY_DISPOSITIONS).toEqual([
      "success",
      "transient_failure",
      "hard_failure",
      "ignored",
    ]);
    expect(RECOVERY_OPERATION_REJECTION_CODES).toContain("stale_epoch");
    expect(FAILBACK_SKIP_REASONS).toContain("origin_no_longer_preferred");
    expect(new Set(FAILBACK_SKIP_REASONS).size).toBe(FAILBACK_SKIP_REASONS.length);
  });
});

describe("canonical recovery scopes", () => {
  const scopes: readonly RecoveryScope[] = [
    { kind: "vendor-type", vendorId: 7, providerType: " OpenAI " },
    { kind: "provider", providerId: 12 },
    { kind: "endpoint", providerId: 12, endpoint: { kind: "managed", endpointId: 34 } },
    {
      kind: "capability",
      providerId: 12,
      modelFamily: " GPT-5 ",
      transport: " HTTPS ",
    },
  ];

  test("serializes every scope with a stable version and field order", () => {
    expect(scopes.map(canonicalizeRecoveryScope)).toEqual([
      '["recovery-scope",1,"vendor-type",7,"openai"]',
      '["recovery-scope",1,"provider",12]',
      '["recovery-scope",1,"endpoint",12,"managed",34]',
      '["recovery-scope",1,"capability",12,"gpt-5","https"]',
    ]);
    expect(scopes.map(hashRecoveryScope)).toEqual([
      "c188c975c89c4bbf0830ec49afd35d5be106ded2bf5f47522241e7d68e3195bc",
      "9886b341c70978181c1994ea4d39a7425c4bbb3e2ac5de22a62ad5bb859b3a4c",
      "d162cca89af6736e504064d38e954aa3357442966cca7b7cd457349eff066632",
      "3e76e891f37b9f3fe6e0623570562bebb3857f72b61b35e2e22e17df922491f7",
    ]);
  });

  test("orders scopes by the composite claim contract", () => {
    expect(sortRecoveryScopes(scopes.toReversed()).map((scope) => scope.kind)).toEqual([
      "vendor-type",
      "provider",
      "endpoint",
      "capability",
    ]);
    expect(compareRecoveryScopes(scopes[0], scopes[1])).toBeLessThan(0);
  });

  test("rejects non-canonical and invalid identity fields", () => {
    expect(() => normalizeRecoveryIdentifier("a\nb", "value")).toThrow(TypeError);
    expect(() => canonicalizeRecoveryScope({ kind: "provider", providerId: 0 })).toThrow(
      RangeError
    );
    expect(() =>
      canonicalizeRecoveryScope({
        kind: "endpoint",
        providerId: 1,
        endpoint: { kind: "direct", endpointHash: "ABC" },
      })
    ).toThrow(TypeError);
  });
});

describe("direct endpoint fingerprinting", () => {
  test("uses only scheme, normalized host, effective port, and endpoint family", () => {
    const secretUrl =
      "https://api-user:api-password@EXAMPLE.com/v1/threads/private-id?api_key=secret#token";
    const canonical = canonicalizeDirectEndpoint(secretUrl, " Responses ");
    expect(canonical).toBe('["direct-endpoint",1,"https","example.com","443","responses"]');

    const ref = fingerprintDirectEndpoint(secretUrl, "responses");
    expect(ref).toEqual({
      kind: "direct",
      endpointHash: "f59ad66fdaab5643c8df20b8abb4646a68a3e9d197386324e9abc7d3dba3a2c7",
    });
    expect(JSON.stringify(ref)).not.toMatch(
      /api-user|api-password|private-id|api_key|secret|token/
    );
  });

  test("normalizes default ports but keeps distinct endpoint families and non-default ports", () => {
    expect(fingerprintDirectEndpoint("https://EXAMPLE.com:443/a", "messages")).toEqual(
      fingerprintDirectEndpoint("https://example.com/b?secret=x", "messages")
    );
    expect(fingerprintDirectEndpoint("http://example.com/a", "messages")).not.toEqual(
      fingerprintDirectEndpoint("https://example.com/a", "messages")
    );
    expect(fingerprintDirectEndpoint("https://example.com:8443/a", "messages")).not.toEqual(
      fingerprintDirectEndpoint("https://example.com/a", "messages")
    );
    expect(fingerprintDirectEndpoint("https://example.com/a", "messages")).not.toEqual(
      fingerprintDirectEndpoint("https://example.com/a", "responses")
    );
    expect(() => fingerprintDirectEndpoint("file:///private/secret", "messages")).toThrow(
      TypeError
    );
  });
});

describe("unbiased deterministic buckets", () => {
  test("keeps stable routing and failback vectors", () => {
    expect(bucket10000("recovery-layer-v1", "session-1:p0")).toBe(5419);
    expect(recoveryLayerBucket("session-1", "p0")).toBe(5419);
    expect(sessionFailbackBucket("session-1")).toBe(4957);
    expect(recoveryLayerBucket("session-1", "p0")).toBe(recoveryLayerBucket("session-1", "p0"));
  });

  test("rejects the modulo-bias tail and consumes later words or digests", () => {
    expect(BUCKET_REJECTION_LIMIT).toBe(4_294_960_000);
    expect(bucket10000WithDigest("d", "k", () => uint32Digest(4_294_959_999))).toBe(9_999);
    expect(
      bucket10000WithDigest("d", "k", () =>
        uint32Digest(BUCKET_REJECTION_LIMIT, 0xffff_ffff, 12_345)
      )
    ).toBe(2_345);

    let calls = 0;
    expect(
      bucket10000WithDigest("d", "k", () => {
        calls += 1;
        return calls === 1 ? uint32Digest(0xffff_ffff) : uint32Digest(9_876);
      })
    ).toBe(9_876);
    expect(calls).toBe(2);
  });

  test("validates digest and bucket inputs", () => {
    expect(() => bucket10000WithDigest("", "k", () => uint32Digest(0))).toThrow(TypeError);
    expect(() => bucket10000WithDigest("d", "k", () => new Uint8Array(3))).toThrow(TypeError);
    expect(() => isBasisPointBucketAdmitted(-1, 1)).toThrow(RangeError);
    expect(() => isBasisPointBucketAdmitted(1, 10_001)).toThrow(RangeError);
    expect(() => failbackRolloutBasisPoints(1.5)).toThrow(RangeError);
  });

  test("applies exact routing and failback thresholds across all 10,000 buckets", () => {
    const buckets = Array.from({ length: 10_000 }, (_, bucket) => bucket);
    for (const basisPoints of [0, 500, 2_500, 5_000, 7_500, 10_000]) {
      expect(
        buckets.filter((bucket) => isBasisPointBucketAdmitted(bucket, basisPoints))
      ).toHaveLength(basisPoints);
    }
    for (const percent of Array.from({ length: 101 }, (_, value) => value)) {
      const basisPoints = failbackRolloutBasisPoints(percent);
      expect(
        buckets.filter((bucket) => isBasisPointBucketAdmitted(bucket, basisPoints))
      ).toHaveLength(percent * 100);
    }
  });
});

describe("recovery stages", () => {
  test("defines the fixed monotonic admission stages and timing allocation", () => {
    expect(RECOVERY_STAGES.map(({ basisPoints }) => basisPoints)).toEqual([
      500, 2_500, 5_000, 7_500, 10_000,
    ]);
    expect(RECOVERY_STAGES.map(({ rampWeightPercent }) => rampWeightPercent)).toEqual([
      20,
      20,
      20,
      40,
      null,
    ]);
    expect(RECOVERY_STAGES.map((stage) => recoveryStageAt(stage.index))).toEqual(RECOVERY_STAGES);
    expect(
      RECOVERY_STAGES.map((stage) => minimumRecoveryStageDurationMs(stage.index, 301, 61))
    ).toEqual([61, 61, 61, 121, 61]);
  });

  test("rejects invalid stage configuration", () => {
    expect(() => recoveryStageAt(5)).toThrow(RangeError);
    expect(() => minimumRecoveryStageDurationMs(0, 0, 1)).toThrow(RangeError);
    expect(() => minimumRecoveryStageDurationMs(0, 1, 0)).toThrow(RangeError);
  });
});

describe("nullable configuration resolution", () => {
  test("resolves provider, system, environment, and code precedence", () => {
    expect(resolveRecoverySetting({ provider: 1, system: 2, environment: 3, code: 4 })).toEqual({
      configured: 1,
      effective: 1,
      source: "provider",
    });
    expect(resolveRecoverySetting({ provider: null, system: 2, environment: 3, code: 4 })).toEqual({
      configured: 2,
      effective: 2,
      source: "system",
    });
    expect(
      resolveRecoverySetting({ provider: null, system: null, environment: 3, code: 4 })
    ).toEqual({
      configured: null,
      effective: 3,
      source: "environment",
    });
    expect(
      resolveRecoverySetting({ provider: null, system: null, environment: null, code: 4 })
    ).toEqual({ configured: null, effective: 4, source: "code" });
  });

  test("resolves API-key failback override before inherited layers", () => {
    expect(
      resolveFailbackMode({
        apiKey: "safe_auto",
        system: "sticky",
        environment: "sticky",
        code: "sticky",
      })
    ).toEqual({ configured: "safe_auto", effective: "safe_auto", source: "api_key" });
    expect(
      resolveFailbackMode({
        apiKey: "inherit",
        system: null,
        environment: "safe_auto",
        code: "sticky",
      })
    ).toEqual({ configured: null, effective: "safe_auto", source: "environment" });
  });
});

describe("request and attempt identity", () => {
  test("preserves one request identity and creates one outcome identity per attempt", () => {
    expect(createRequestId(() => "request-id")).toBe("request_request-id");
    const first = createAttemptIdentity("request_request-id", 0, "primary", () => "attempt-1");
    const second = createAttemptIdentity("request_request-id", 1, "retry", () => "attempt-2");
    expect(first).toEqual({
      requestId: "request_request-id",
      attemptOutcomeId: "attempt_attempt-1",
      attemptNumber: 0,
      attemptKind: "primary",
    });
    expect(second.requestId).toBe(first.requestId);
    expect(second.attemptOutcomeId).not.toBe(first.attemptOutcomeId);
  });

  test("rejects invalid attempt identity inputs", () => {
    expect(() => createAttemptIdentity("", 0, "primary")).toThrow(TypeError);
    expect(() => createAttemptIdentity("request", -1, "primary")).toThrow(RangeError);
  });
});
