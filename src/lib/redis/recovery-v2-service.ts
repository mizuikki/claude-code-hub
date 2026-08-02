import { randomUUID } from "node:crypto";
import type {
  RecoveryDisposition,
  RecoveryHealth,
  RecoveryScope,
  RecoverySettings,
  RecoveryState,
} from "@/lib/recovery/contracts";
import { canonicalizeRecoveryScope } from "@/lib/recovery/scope";
import { recoveryStageAt } from "@/lib/recovery/stages";
import {
  type RecoveryKeyNamespace,
  type RecoveryScopeKeys,
  recoveryScopeKeys,
} from "./recovery-v2-keys";
import { RECOVERY_V2_LUA } from "./recovery-v2-lua";

export interface RecoveryRedisClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export type RecoveryCommandCode =
  | "applied"
  | "duplicate"
  | "exists"
  | "not_found"
  | "stale_epoch"
  | "stale_token"
  | "invalid_state"
  | "paused"
  | "not_due"
  | "capacity_exhausted"
  | "lease_not_found"
  | "bucket_rejected"
  | "insufficient_samples"
  | "confirmation_required"
  | "invalid_operation";

export interface RecoveryCommandResult {
  readonly code: RecoveryCommandCode;
  readonly epoch: number;
  readonly health: RecoveryHealth | "unknown";
  readonly details: readonly (string | number)[];
}

export interface RecoveryTrialLease {
  readonly scope: RecoveryScope;
  readonly epoch: number;
  readonly attemptOutcomeId: string;
  readonly requestId: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface RecoveryProbeLease {
  readonly scope: RecoveryScope;
  readonly epoch: number;
  readonly token: string;
  readonly expiresAt: number;
}

export interface RecoveryStateSnapshot extends RecoveryState {
  readonly trialOccupancy: number;
  readonly redisTimeMs: number;
  readonly window: {
    readonly total: number;
    readonly success: number;
    readonly failure: number;
    readonly slow: number;
    readonly hard: number;
  };
}

const RESULT_CODES: Record<string, RecoveryCommandCode> = {
  APPLIED: "applied",
  DUPLICATE: "duplicate",
  EXISTS: "exists",
  NOT_FOUND: "not_found",
  STALE_EPOCH: "stale_epoch",
  STALE_TOKEN: "stale_token",
  INVALID_STATE: "invalid_state",
  PAUSED: "paused",
  NOT_DUE: "not_due",
  CAPACITY_EXHAUSTED: "capacity_exhausted",
  LEASE_NOT_FOUND: "lease_not_found",
  BUCKET_REJECTED: "bucket_rejected",
  INSUFFICIENT_SAMPLES: "insufficient_samples",
  CONFIRMATION_REQUIRED: "confirmation_required",
  INVALID_OPERATION: "invalid_operation",
};

const HEALTH_VALUES = new Set<RecoveryHealth>([
  "closed",
  "open",
  "probing",
  "half_open",
  "recovering",
]);

function asArray(raw: unknown): Array<string | number> {
  if (!Array.isArray(raw)) throw new TypeError("recovery Lua result must be an array");
  return raw.map((value) => {
    if (typeof value === "number") return value;
    if (typeof value === "string") return value;
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    throw new TypeError("recovery Lua result contains an unsupported value");
  });
}

function numberValue(value: string | number | undefined, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nullableTimestamp(value: string | undefined): number | null {
  const parsed = Number(value ?? 0);
  return parsed > 0 ? parsed : null;
}

function nullableString(value: string | undefined): string | null {
  return value ? value : null;
}

function validateIdentityPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new TypeError(`${field} must be a bounded opaque identifier`);
  }
}

export class RecoveryV2Service {
  constructor(
    private readonly redis: RecoveryRedisClient,
    private readonly settings: RecoverySettings,
    private readonly namespace: RecoveryKeyNamespace = "production"
  ) {}

  private keys(scope: RecoveryScope): RecoveryScopeKeys {
    return recoveryScopeKeys(scope, this.namespace);
  }

  private async run(scope: RecoveryScope, args: readonly (string | number)[]) {
    const keys = this.keys(scope);
    const raw = await this.redis.eval(
      RECOVERY_V2_LUA,
      4,
      keys.state,
      keys.trials,
      keys.outcomes,
      keys.window,
      ...args.map(String)
    );
    return asArray(raw);
  }

  private commandResult(raw: Array<string | number>): RecoveryCommandResult {
    const code = RESULT_CODES[String(raw[0])];
    if (!code) throw new TypeError(`unknown recovery Lua result code: ${String(raw[0])}`);
    const healthValue = String(raw[2] ?? "unknown");
    return {
      code,
      epoch: numberValue(raw[1], -1),
      health: HEALTH_VALUES.has(healthValue as RecoveryHealth)
        ? (healthValue as RecoveryHealth)
        : "unknown",
      details: raw.slice(3),
    };
  }

  private outcomeArguments(input: {
    expectedEpoch: number;
    attemptOutcomeId: string;
    disposition: RecoveryDisposition;
    durationMs: number;
  }): Array<string | number> {
    validateIdentityPart(input.attemptOutcomeId, "attemptOutcomeId");
    return [
      input.expectedEpoch,
      input.attemptOutcomeId,
      input.disposition,
      Math.max(0, Math.trunc(input.durationMs)),
      this.settings.windowDurationMs,
      this.settings.bucketDurationMs,
      this.settings.slowCallDurationMs ?? 0,
      this.settings.minimumRealOutcomes,
      this.settings.maximumFailureRate,
      this.settings.maximumSlowCallRate,
      this.settings.failureThreshold,
      this.settings.consecutiveHard5xxThreshold,
      this.settings.halfOpenSuccessThreshold,
      this.settings.openDurationMs,
      this.settings.stateRetentionMs,
    ];
  }

  async initializeScope(
    scope: RecoveryScope,
    initialHealth: "closed" | "open"
  ): Promise<RecoveryCommandResult> {
    return this.commandResult(
      await this.run(scope, [
        "initialize",
        initialHealth,
        this.settings.openDurationMs,
        this.settings.stateRetentionMs,
        canonicalizeRecoveryScope(scope),
      ])
    );
  }

  async getState(scope: RecoveryScope): Promise<RecoveryStateSnapshot | null> {
    const raw = await this.run(scope, [
      "get_state",
      this.settings.windowDurationMs,
      this.settings.stateRetentionMs,
      this.settings.stateRetentionMs,
    ]);
    if (raw[0] === "NOT_FOUND") return null;
    if (raw[0] !== "APPLIED") throw new TypeError(`unexpected get-state result: ${raw[0]}`);
    const occupancy = numberValue(raw[1]);
    const redisTimeMs = numberValue(raw[2]);
    const fields: Record<string, string> = {};
    for (let index = 3; index < raw.length; index += 2) {
      fields[String(raw[index])] = String(raw[index + 1] ?? "");
    }
    const health = fields.health as RecoveryHealth;
    if (!HEALTH_VALUES.has(health))
      throw new TypeError(`invalid persisted recovery health: ${health}`);
    return {
      version: 2,
      scope,
      health,
      epoch: numberValue(fields.epoch),
      automationPaused: fields.automation_paused === "1",
      pausedAt: nullableTimestamp(fields.paused_at),
      pausedReason: nullableString(fields.paused_reason),
      failureCount: numberValue(fields.failure_count),
      consecutiveHardFailureCount: numberValue(fields.consecutive_hard_failure_count),
      lastFailureAt: nullableTimestamp(fields.last_failure_at),
      openedAt: nullableTimestamp(fields.opened_at),
      openUntil: nullableTimestamp(fields.open_until),
      nextProbeAt: nullableTimestamp(fields.next_probe_at),
      probeAttemptCount: numberValue(fields.probe_attempt_count),
      probeLeaseToken: nullableString(fields.probe_token),
      probeLeaseUntil: nullableTimestamp(fields.probe_until),
      halfOpenSuccessCount: numberValue(fields.half_open_success_count),
      recoveryStartedAt: nullableTimestamp(fields.recovery_started_at),
      recoveryStageIndex: numberValue(fields.recovery_stage_index),
      recoveryStageStartedAt: nullableTimestamp(fields.recovery_stage_started_at),
      closedStableAt: nullableTimestamp(fields.closed_stable_at),
      lastProbeAt: nullableTimestamp(fields.last_probe_at),
      lastProbeSucceededAt: nullableTimestamp(fields.last_probe_succeeded_at),
      lastStateChangeAt: numberValue(fields.last_change_at),
      trialOccupancy: occupancy,
      redisTimeMs,
      window: {
        total: numberValue(fields.window_total),
        success: numberValue(fields.window_success),
        failure: numberValue(fields.window_failure),
        slow: numberValue(fields.window_slow),
        hard: numberValue(fields.window_hard),
      },
    };
  }

  async recordAttemptOutcome(input: {
    scope: RecoveryScope;
    expectedEpoch: number;
    attemptOutcomeId: string;
    disposition: RecoveryDisposition;
    durationMs: number;
  }): Promise<RecoveryCommandResult> {
    return this.commandResult(
      await this.run(input.scope, [
        "record_outcome",
        ...this.outcomeArguments(input),
        this.settings.stateRetentionMs,
      ])
    );
  }

  async claimPassiveHalfOpen(
    scope: RecoveryScope,
    expectedEpoch: number
  ): Promise<RecoveryCommandResult> {
    return this.commandResult(
      await this.run(scope, ["claim_passive", expectedEpoch, this.settings.stateRetentionMs])
    );
  }

  async claimProbe(input: {
    scope: RecoveryScope;
    expectedEpoch: number;
    leaseMs: number;
    token?: string;
  }): Promise<RecoveryProbeLease | RecoveryCommandResult> {
    const token = input.token ?? randomUUID();
    validateIdentityPart(token, "probe token");
    const result = this.commandResult(
      await this.run(input.scope, [
        "claim_probe",
        input.expectedEpoch,
        token,
        input.leaseMs,
        this.settings.stateRetentionMs,
      ])
    );
    if (result.code !== "applied") return result;
    return {
      scope: input.scope,
      epoch: result.epoch,
      token,
      expiresAt: numberValue(result.details[1]),
    };
  }

  async completeProbe(input: {
    lease: RecoveryProbeLease;
    succeeded: boolean;
    nextProbeDelayMs: number;
  }): Promise<RecoveryCommandResult> {
    return this.commandResult(
      await this.run(input.lease.scope, [
        "complete_probe",
        input.lease.epoch,
        input.lease.token,
        input.succeeded ? 1 : 0,
        input.nextProbeDelayMs,
        this.settings.openDurationMs,
        this.settings.stateRetentionMs,
      ])
    );
  }

  async claimHalfOpenTrial(input: {
    scope: RecoveryScope;
    expectedEpoch: number;
    attemptOutcomeId: string;
    requestId: string;
    leaseMs: number;
    token?: string;
  }): Promise<RecoveryTrialLease | RecoveryCommandResult> {
    validateIdentityPart(input.attemptOutcomeId, "attemptOutcomeId");
    validateIdentityPart(input.requestId, "requestId");
    const token = input.token ?? randomUUID();
    validateIdentityPart(token, "trial token");
    const result = this.commandResult(
      await this.run(input.scope, [
        "claim_trial",
        input.expectedEpoch,
        input.attemptOutcomeId,
        input.requestId,
        token,
        input.leaseMs,
        this.settings.halfOpenMaxConcurrency,
        this.settings.stateRetentionMs,
      ])
    );
    if (result.code !== "applied") return result;
    return {
      scope: input.scope,
      epoch: result.epoch,
      attemptOutcomeId: input.attemptOutcomeId,
      requestId: input.requestId,
      token,
      expiresAt: numberValue(result.details[2]),
    };
  }

  async renewHalfOpenTrial(
    lease: RecoveryTrialLease,
    leaseMs: number
  ): Promise<RecoveryTrialLease | RecoveryCommandResult> {
    const result = this.commandResult(
      await this.run(lease.scope, [
        "renew_trial",
        lease.epoch,
        lease.attemptOutcomeId,
        lease.requestId,
        lease.token,
        leaseMs,
        this.settings.stateRetentionMs,
      ])
    );
    if (result.code !== "applied") return result;
    return { ...lease, expiresAt: numberValue(result.details[0]) };
  }

  async releaseHalfOpenTrial(lease: RecoveryTrialLease): Promise<RecoveryCommandResult> {
    return this.commandResult(
      await this.run(lease.scope, [
        "release_trial",
        lease.epoch,
        lease.attemptOutcomeId,
        lease.requestId,
        lease.token,
        this.settings.stateRetentionMs,
      ])
    );
  }

  async completeHalfOpenTrial(input: {
    lease: RecoveryTrialLease;
    disposition: RecoveryDisposition;
    durationMs: number;
  }): Promise<RecoveryCommandResult> {
    const outcomeArgs = this.outcomeArguments({
      expectedEpoch: input.lease.epoch,
      attemptOutcomeId: input.lease.attemptOutcomeId,
      disposition: input.disposition,
      durationMs: input.durationMs,
    });
    return this.commandResult(
      await this.run(input.lease.scope, [
        "complete_trial",
        input.lease.epoch,
        input.lease.attemptOutcomeId,
        input.lease.requestId,
        input.lease.token,
        ...outcomeArgs.slice(2),
        this.settings.stateRetentionMs,
      ])
    );
  }

  async validateRecoveryAdmission(input: {
    scope: RecoveryScope;
    expectedEpoch: number;
    expectedStageIndex: number;
    bucket: number;
  }): Promise<RecoveryCommandResult> {
    const ceiling = recoveryStageAt(input.expectedStageIndex).basisPoints;
    return this.commandResult(
      await this.run(input.scope, [
        "validate_admission",
        input.expectedEpoch,
        input.expectedStageIndex,
        input.bucket,
        ceiling,
        this.settings.stateRetentionMs,
      ])
    );
  }

  async advanceRecovery(
    scope: RecoveryScope,
    expectedEpoch: number
  ): Promise<RecoveryCommandResult> {
    return this.commandResult(
      await this.run(scope, [
        "advance_recovery",
        expectedEpoch,
        this.settings.windowDurationMs,
        this.settings.minimumRealOutcomes,
        this.settings.maximumFailureRate,
        this.settings.maximumSlowCallRate,
        this.settings.rampDurationMs,
        this.settings.stableDurationMs,
        this.settings.openDurationMs,
        this.settings.stateRetentionMs,
      ])
    );
  }

  async administrate(input: {
    scope: RecoveryScope;
    action: "pause" | "resume" | "reset" | "force_open" | "force_close";
    expectedEpoch: number;
    reason: string;
    confirmation?: "FORCE_CLOSE";
  }): Promise<RecoveryCommandResult> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) {
      throw new TypeError("administrative recovery reason must contain 1 through 500 characters");
    }
    return this.commandResult(
      await this.run(input.scope, [
        "admin",
        input.action,
        input.expectedEpoch,
        reason,
        input.confirmation ?? "",
        this.settings.openDurationMs,
        this.settings.stateRetentionMs,
      ])
    );
  }
}
