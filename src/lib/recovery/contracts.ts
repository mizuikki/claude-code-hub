export const RECOVERY_HEALTH_VALUES = [
  "closed",
  "open",
  "probing",
  "half_open",
  "recovering",
] as const;

export type RecoveryHealth = (typeof RECOVERY_HEALTH_VALUES)[number];

export const RECOVERY_AUTHORITY_MODES = ["legacy", "shadow", "enforce"] as const;
export type RecoveryAuthorityMode = (typeof RECOVERY_AUTHORITY_MODES)[number];

export const SESSION_BINDING_AUTHORITY_MODES = [
  "legacy",
  "shadow",
  "v2_dual_write",
  "v2_only",
] as const;
export type SessionBindingAuthorityMode = (typeof SESSION_BINDING_AUTHORITY_MODES)[number];

export const SESSION_FAILBACK_MODES = ["sticky", "safe_auto"] as const;
export type SessionFailbackMode = (typeof SESSION_FAILBACK_MODES)[number];
export type SessionFailbackModeOverride = "inherit" | SessionFailbackMode;

export const RECOVERY_EVIDENCE_CLASSES = ["none", "connectivity", "business"] as const;
export type RecoveryEvidenceClass = (typeof RECOVERY_EVIDENCE_CLASSES)[number];

export const MIGRATION_SAFETY_VALUES = ["replayable", "provider_bound", "unknown"] as const;
export type MigrationSafety = (typeof MIGRATION_SAFETY_VALUES)[number];

export const RETRY_SAFETY_VALUES = ["pre_commit_only", "idempotent", "never"] as const;
export type RetrySafety = (typeof RETRY_SAFETY_VALUES)[number];

export interface EndpointRecoveryPolicy {
  readonly recoveryEvidence: RecoveryEvidenceClass;
  readonly halfOpenEligible: boolean;
  readonly retrySafety: RetrySafety;
  readonly migrationSafety: MigrationSafety;
  readonly trackSessionBinding: boolean;
}

export interface ManagedEndpointRef {
  readonly kind: "managed";
  readonly endpointId: number;
}

export interface DirectEndpointRef {
  readonly kind: "direct";
  readonly endpointHash: string;
}

export type EndpointRef = ManagedEndpointRef | DirectEndpointRef;

export type RecoveryScope =
  | {
      readonly kind: "vendor-type";
      readonly vendorId: number;
      readonly providerType: string;
    }
  | { readonly kind: "provider"; readonly providerId: number }
  | {
      readonly kind: "endpoint";
      readonly providerId: number;
      readonly endpoint: EndpointRef;
    }
  | {
      readonly kind: "capability";
      readonly providerId: number;
      readonly modelFamily: string;
      readonly transport: string;
    };

export interface ProviderLimitScope {
  readonly providerId: number;
  readonly credentialFingerprint: string;
}

export interface RecoveryState {
  readonly version: 2;
  readonly scope: RecoveryScope;
  readonly health: RecoveryHealth;
  readonly epoch: number;
  readonly automationPaused: boolean;
  readonly pausedAt: number | null;
  readonly pausedReason: string | null;
  readonly failureCount: number;
  readonly consecutiveHardFailureCount: number;
  readonly lastFailureAt: number | null;
  readonly openedAt: number | null;
  readonly openUntil: number | null;
  readonly nextProbeAt: number | null;
  readonly probeAttemptCount: number;
  readonly probeLeaseToken: string | null;
  readonly probeLeaseUntil: number | null;
  readonly halfOpenSuccessCount: number;
  readonly recoveryStartedAt: number | null;
  readonly recoveryStageIndex: number;
  readonly recoveryStageStartedAt: number | null;
  readonly closedStableAt: number | null;
  readonly lastProbeAt: number | null;
  readonly lastProbeSucceededAt: number | null;
  readonly lastStateChangeAt: number;
}

export const ATTEMPT_KINDS = ["primary", "retry", "race", "probe", "failback"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export interface AttemptIdentity {
  readonly requestId: string;
  readonly attemptOutcomeId: string;
  readonly attemptNumber: number;
  readonly attemptKind: AttemptKind;
}

export const RECOVERY_DISPOSITIONS = [
  "success",
  "transient_failure",
  "hard_failure",
  "ignored",
] as const;
export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

export interface RecoveryEffect {
  readonly scope: RecoveryScope;
  readonly disposition: RecoveryDisposition;
  readonly reason: string;
}

export type ProviderLimitEffect =
  | {
      readonly disposition: "cooldown";
      readonly scope: ProviderLimitScope;
      readonly retryAfterMs: number;
      readonly reason: string;
    }
  | {
      readonly disposition: "clear";
      readonly scope: ProviderLimitScope;
      readonly reason: string;
    };

export interface ClassifiedAttemptOutcome {
  readonly identity: AttemptIdentity;
  readonly effects: readonly RecoveryEffect[];
  readonly providerLimit: ProviderLimitEffect | null;
  readonly retrySafety: RetrySafety;
  readonly upstreamCommitted: boolean;
  readonly downstreamCommitted: boolean;
  readonly durationMs: number;
}

export const RECOVERY_OPERATION_REJECTION_CODES = [
  "not_found",
  "stale_epoch",
  "stale_token",
  "invalid_state",
  "paused",
  "not_due",
  "capacity_exhausted",
  "lease_not_found",
  "bucket_rejected",
] as const;
export type RecoveryOperationRejectionCode = (typeof RECOVERY_OPERATION_REJECTION_CODES)[number];

export type RecoveryOperationResult<T> =
  | { readonly code: "applied"; readonly value: T }
  | { readonly code: "duplicate"; readonly value: T }
  | {
      readonly code: RecoveryOperationRejectionCode;
      readonly currentEpoch: number | null;
    };

export const FAILBACK_SKIP_REASONS = [
  "stateless",
  "sticky_mode",
  "not_failover_binding",
  "endpoint_not_replayable",
  "request_blocked",
  "origin_not_closed",
  "origin_not_stable",
  "origin_no_longer_preferred",
  "origin_not_higher_priority",
  "origin_ineligible",
  "delay_not_elapsed",
  "cooldown_active",
  "rollout_miss",
  "global_capacity",
  "session_busy",
  "migration_in_progress",
  "coordination_unavailable",
] as const;
export type FailbackSkipReason = (typeof FAILBACK_SKIP_REASONS)[number];

export type SettingSource = "provider" | "system" | "environment" | "code" | "api_key";

export interface ResolvedSetting<T> {
  readonly configured: T | null;
  readonly effective: T;
  readonly source: SettingSource;
}

export interface SessionFailbackSettings {
  readonly mode: SessionFailbackMode;
  readonly delayMs: number;
  readonly retryCooldownMs: number;
  readonly rolloutPercent: number;
  readonly maxConcurrentMigrations: number;
  readonly migrationWaitMs: number;
}

export interface RecoverySettings {
  readonly openDurationMs: number;
  readonly windowDurationMs: number;
  readonly bucketDurationMs: number;
  readonly minimumRealOutcomes: number;
  readonly failureThreshold: number;
  readonly maximumFailureRate: number;
  readonly slowCallDurationMs: number | null;
  readonly maximumSlowCallRate: number;
  readonly consecutiveHard5xxThreshold: number;
  readonly rampDurationMs: number;
  readonly stableDurationMs: number;
  readonly halfOpenMaxConcurrency: number;
  readonly halfOpenSuccessThreshold: number;
  readonly stateRetentionMs: number;
  readonly passiveHalfOpenEnabled: boolean;
  readonly recoveryTrafficEnabled: boolean;
  readonly activeProbesEnabled: boolean;
}

export interface RecoveryProbeBudgets {
  readonly safeModel: string | null;
  readonly globalConcurrency: number;
  readonly providerConcurrency: number;
  readonly requestsPerMinute: number;
  readonly maxTokensPerProbe: number;
  readonly timeoutMs: number;
  readonly dailyCostUsd: number;
}

export type NullableSettings<T> = {
  readonly [Key in keyof T]: T[Key] | null;
};

export type RecoverySettingsOverrides = Partial<NullableSettings<RecoverySettings>>;
export type RecoveryProbeBudgetOverrides = Partial<NullableSettings<RecoveryProbeBudgets>>;
export type SessionFailbackSettingsOverrides = Partial<NullableSettings<SessionFailbackSettings>>;
