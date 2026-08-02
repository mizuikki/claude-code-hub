import {
  CODE_FAILBACK_DEFAULTS,
  CODE_PROBE_BUDGET_DEFAULTS,
  CODE_RECOVERY_DEFAULTS,
  RecoveryProbeBudgetOverridesSchema,
  RecoverySettingsOverridesSchema,
  SessionFailbackSettingsOverridesSchema,
  recoveryStartupSettingsFromEnv,
  resolveRecoveryConfiguration,
  validateEffectiveRecoverySettings,
} from "@/lib/recovery/config";
import { EnvSchema } from "@/lib/config/env.schema";

describe("recovery configuration", () => {
  test("parses nullable startup layers without materializing code defaults", () => {
    const startup = recoveryStartupSettingsFromEnv(EnvSchema.parse({ NODE_ENV: "test" }));
    expect(startup).toMatchObject({
      recoveryAuthorityMode: "legacy",
      sessionBindingAuthorityMode: "legacy",
      recovery: {
        windowDurationMs: null,
        activeProbesEnabled: null,
      },
      failback: { mode: null },
    });
  });

  test("parses explicit environment settings and maps the legacy probe toggle narrowly", () => {
    const legacy = recoveryStartupSettingsFromEnv(
      EnvSchema.parse({ NODE_ENV: "test", ENABLE_SMART_PROBING: "true" })
    );
    expect(legacy.recovery.activeProbesEnabled).toBe(true);
    expect(legacy.recoveryAuthorityMode).toBe("legacy");
    expect(legacy.recovery.recoveryTrafficEnabled).toBeNull();

    const current = recoveryStartupSettingsFromEnv(
      EnvSchema.parse({
        NODE_ENV: "test",
        ENABLE_SMART_PROBING: "true",
        RECOVERY_ACTIVE_PROBES_ENABLED: "false",
        RECOVERY_AUTHORITY_MODE: "shadow",
        SESSION_BINDING_AUTHORITY_MODE: "v2_dual_write",
        RECOVERY_WINDOW_DURATION_MS: "120000",
        SESSION_FAILBACK_MODE: "safe_auto",
      })
    );
    expect(current.recovery.activeProbesEnabled).toBe(false);
    expect(current.recovery.windowDurationMs).toBe(120_000);
    expect(current.recoveryAuthorityMode).toBe("shadow");
    expect(current.sessionBindingAuthorityMode).toBe("v2_dual_write");
    expect(current.failback.mode).toBe("safe_auto");
  });

  test("resolves each field independently through provider, system, environment, and code", () => {
    const startup = recoveryStartupSettingsFromEnv(
      EnvSchema.parse({
        NODE_ENV: "test",
        RECOVERY_WINDOW_DURATION_MS: "120000",
        RECOVERY_BUCKET_DURATION_MS: "10000",
        RECOVERY_PROBE_MAX_TOKENS: "64",
        SESSION_FAILBACK_DELAY_MS: "1234",
      })
    );
    const resolved = resolveRecoveryConfiguration({
      providerRecovery: { minimumRealOutcomes: 9 },
      providerProbeBudgets: { safeModel: "provider-safe-model" },
      systemRecovery: { maximumFailureRate: 0.02 },
      systemProbeBudgets: { requestsPerMinute: 4 },
      systemFailback: { mode: "safe_auto" },
      startup,
    });

    expect(resolved.recovery.minimumRealOutcomes).toEqual({
      configured: 9,
      effective: 9,
      source: "provider",
    });
    expect(resolved.recovery.maximumFailureRate.source).toBe("system");
    expect(resolved.recovery.windowDurationMs.source).toBe("environment");
    expect(resolved.recovery.rampDurationMs).toEqual({
      configured: null,
      effective: CODE_RECOVERY_DEFAULTS.rampDurationMs,
      source: "code",
    });
    expect(resolved.probeBudgets.safeModel.source).toBe("provider");
    expect(resolved.probeBudgets.requestsPerMinute.source).toBe("system");
    expect(resolved.probeBudgets.maxTokensPerProbe.effective).toBe(64);
    expect(resolved.probeBudgets.timeoutMs.effective).toBe(CODE_PROBE_BUDGET_DEFAULTS.timeoutMs);
    expect(resolved.failback.mode.source).toBe("system");
    expect(resolved.failback.delayMs.effective).toBe(1234);
    expect(resolved.failback.migrationWaitMs.effective).toBe(
      CODE_FAILBACK_DEFAULTS.migrationWaitMs
    );
  });

  test("validates nullable JSON overrides and effective cross-field contracts", () => {
    expect(RecoverySettingsOverridesSchema.parse({ slowCallDurationMs: null })).toEqual({
      slowCallDurationMs: null,
    });
    expect(RecoveryProbeBudgetOverridesSchema.parse({ safeModel: null })).toEqual({
      safeModel: null,
    });
    expect(SessionFailbackSettingsOverridesSchema.parse({ mode: null })).toEqual({ mode: null });
    expect(() => RecoverySettingsOverridesSchema.parse({ unknown: 1 })).toThrow();
    expect(() =>
      validateEffectiveRecoverySettings({
        ...CODE_RECOVERY_DEFAULTS,
        windowDurationMs: 60_001,
      })
    ).toThrow("divisible");
    expect(() =>
      validateEffectiveRecoverySettings({
        ...CODE_RECOVERY_DEFAULTS,
        stateRetentionMs: 1,
      })
    ).toThrow("retention");
    expect(() =>
      validateEffectiveRecoverySettings({
        ...CODE_RECOVERY_DEFAULTS,
        halfOpenMaxConcurrency: 3,
        halfOpenSuccessThreshold: 2,
      })
    ).toThrow("success threshold");
  });
});
