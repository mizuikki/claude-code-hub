import { z } from "@hono/zod-openapi";
import {
  RecoveryProbeBudgetOverridesSchema,
  RecoverySettingsOverridesSchema,
  SessionFailbackSettingsOverridesSchema,
} from "@/lib/recovery/config";

export const RecoveryProviderParamSchema = z.object({
  providerId: z.coerce.number().int().positive(),
});

export const RecoveryOperationParamSchema = RecoveryProviderParamSchema.extend({
  action: z.enum(["probe", "pause", "resume", "reset", "force-open", "force-close"]),
});

export const RecoveryEndpointParamSchema = RecoveryProviderParamSchema.extend({
  endpointId: z.coerce.number().int().positive(),
});
export const RecoveryEndpointOperationParamSchema = RecoveryEndpointParamSchema.extend({
  action: RecoveryOperationParamSchema.shape.action,
});

export const RecoveryVendorTypeParamSchema = z.object({
  vendorId: z.coerce.number().int().positive(),
  providerType: z.string().trim().min(1).max(64),
  action: RecoveryOperationParamSchema.shape.action.optional(),
});
export const RecoveryVendorTypeOperationParamSchema = RecoveryVendorTypeParamSchema.extend({
  action: RecoveryOperationParamSchema.shape.action,
});

export const RecoveryCapabilityParamSchema = RecoveryProviderParamSchema.extend({
  modelFamily: z.string().trim().min(1).max(128),
  transport: z.string().trim().min(1).max(32),
});
export const RecoveryCapabilityOperationParamSchema = RecoveryCapabilityParamSchema.extend({
  action: RecoveryOperationParamSchema.shape.action,
});

export const RecoveryOperationSchema = z
  .object({
    expectedEpoch: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    confirmation: z.literal("FORCE_CLOSE").optional(),
  })
  .openapi("RecoveryOperation");

export const CompatibilityCircuitResetSchema = z
  .object({
    expectedEpoch: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .openapi("CompatibilityCircuitReset");

export const RecoveryConfigurationUpdateSchema = z
  .object({
    recoveryAuthorityMode: z.enum(["legacy", "shadow", "enforce"]).nullable().optional(),
    sessionBindingAuthorityMode: z
      .enum(["legacy", "shadow", "v2_dual_write", "v2_only"])
      .nullable()
      .optional(),
    recoverySettings: RecoverySettingsOverridesSchema.nullable().optional(),
    recoveryProbeBudgets: RecoveryProbeBudgetOverridesSchema.nullable().optional(),
    sessionFailbackSettings: SessionFailbackSettingsOverridesSchema.nullable().optional(),
    rolloutProof: z.enum(["fleet_replaced", "maintenance_window"]).optional(),
  })
  .strict();

export const RecoveryProviderConfigurationUpdateSchema = z
  .object({
    recoverySettings: RecoverySettingsOverridesSchema.nullable(),
    recoveryProbeBudgets: RecoveryProbeBudgetOverridesSchema.nullable(),
  })
  .strict();

const RecoveryScopeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("provider"), providerId: z.number().int().positive() }),
    z.object({
      kind: z.literal("vendor-type"),
      vendorId: z.number().int().positive(),
      providerType: z.string(),
    }),
    z.object({
      kind: z.literal("endpoint"),
      providerId: z.number().int().positive(),
      endpoint: z.union([
        z.object({ kind: z.literal("managed"), endpointId: z.number().int().positive() }),
        z.object({ kind: z.literal("direct"), endpointHash: z.string() }),
      ]),
    }),
    z.object({
      kind: z.literal("capability"),
      providerId: z.number().int().positive(),
      modelFamily: z.string(),
      transport: z.string(),
    }),
  ])
  .openapi("RecoveryScope");

const ResolvedSettingSchema = z
  .object({
    configured: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    effective: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    source: z.enum(["provider", "system", "environment", "code", "api_key"]),
  })
  .openapi("RecoveryResolvedSetting");

const RecoveryStateSchema = z
  .object({
    version: z.literal(2),
    scope: RecoveryScopeSchema,
    health: z.enum(["closed", "open", "probing", "half_open", "recovering"]),
    epoch: z.number().int().nonnegative(),
    automationPaused: z.boolean(),
    pausedAt: z.number().nullable(),
    pausedReason: z.string().nullable(),
    failureCount: z.number().int().nonnegative(),
    consecutiveHardFailureCount: z.number().int().nonnegative(),
    lastFailureAt: z.number().nullable(),
    openedAt: z.number().nullable(),
    openUntil: z.number().nullable(),
    nextProbeAt: z.number().nullable(),
    probeAttemptCount: z.number().int().nonnegative(),
    probeLeaseToken: z.string().nullable(),
    probeLeaseUntil: z.number().nullable(),
    halfOpenSuccessCount: z.number().int().nonnegative(),
    recoveryStartedAt: z.number().nullable(),
    recoveryStageIndex: z.number().int().nonnegative(),
    recoveryStageStartedAt: z.number().nullable(),
    closedStableAt: z.number().nullable(),
    lastProbeAt: z.number().nullable(),
    lastProbeSucceededAt: z.number().nullable(),
    lastStateChangeAt: z.number(),
    trialOccupancy: z.number().int().nonnegative(),
    redisTimeMs: z.number(),
    window: z.object({
      total: z.number().int().nonnegative(),
      success: z.number().int().nonnegative(),
      failure: z.number().int().nonnegative(),
      slow: z.number().int().nonnegative(),
      hard: z.number().int().nonnegative(),
    }),
  })
  .openapi("RecoveryState");

export const RecoveryDiagnosticsSchema = z
  .object({
    scope: RecoveryScopeSchema,
    state: RecoveryStateSchema.nullable(),
    configuration: z.object({
      recovery: z.record(z.string(), ResolvedSettingSchema),
      probeBudgets: z.record(z.string(), ResolvedSettingSchema),
      failback: z.record(z.string(), ResolvedSettingSchema),
    }),
    authority: z.object({
      recovery: z.enum(["legacy", "shadow", "enforce"]),
      binding: z.enum(["legacy", "shadow", "v2_dual_write", "v2_only"]),
    }),
    degraded: z.boolean(),
  })
  .openapi("RecoveryDiagnostics");

export const RecoveryOperationResponseSchema = z
  .object({
    code: z.string(),
    epoch: z.number(),
    health: z.string(),
  })
  .openapi("RecoveryOperationResponse");

export const RecoveryConfigurationResponseSchema = z
  .object({
    recoveryAuthorityMode: z.enum(["legacy", "shadow", "enforce"]).nullable(),
    sessionBindingAuthorityMode: z
      .enum(["legacy", "shadow", "v2_dual_write", "v2_only"])
      .nullable(),
    recoverySettings: RecoverySettingsOverridesSchema.nullable(),
    recoveryProbeBudgets: RecoveryProbeBudgetOverridesSchema.nullable(),
    sessionFailbackSettings: SessionFailbackSettingsOverridesSchema.nullable(),
  })
  .openapi("RecoveryConfigurationResponse");

export const RecoveryProviderConfigurationResponseSchema = z
  .object({
    providerId: z.number().int().positive(),
    recoverySettings: RecoverySettingsOverridesSchema.nullable(),
    recoveryProbeBudgets: RecoveryProbeBudgetOverridesSchema.nullable(),
  })
  .openapi("RecoveryProviderConfigurationResponse");
