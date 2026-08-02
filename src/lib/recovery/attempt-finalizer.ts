import type {
  ClassifiedAttemptOutcome,
  ProviderLimitEffect,
  RecoveryEffect,
  RecoveryScope,
} from "./contracts";
import { hashRecoveryScope } from "./scope";

export interface OutcomeSettlementService {
  getState(scope: RecoveryScope): Promise<{ readonly epoch: number } | null>;
  recordAttemptOutcome(input: {
    readonly scope: RecoveryScope;
    readonly expectedEpoch: number;
    readonly attemptOutcomeId: string;
    readonly disposition: RecoveryEffect["disposition"];
    readonly durationMs: number;
  }): Promise<{ readonly code: string }>;
}

export interface LimitSettlementService {
  applyCooldown(input: {
    readonly scope: NonNullable<ProviderLimitEffect>["scope"];
    readonly retryAfterMs: number;
    readonly reason: string;
  }): Promise<unknown>;
}

export interface AttemptSettlementReport {
  readonly status: "applied" | "duplicate";
  readonly settledScopes: readonly string[];
  readonly pendingScopes: readonly string[];
}

export class AttemptOutcomeFinalizer {
  private owner: symbol | null = null;
  private completed = false;
  private inFlight: Promise<AttemptSettlementReport> | null = null;
  private readonly settled = new Set<string>();
  private limitSettled = false;

  constructor(
    readonly outcome: ClassifiedAttemptOutcome,
    private readonly recovery: OutcomeSettlementService,
    private readonly limits: LimitSettlementService | null
  ) {}

  claimOwner(): symbol {
    if (this.owner) throw new Error("attempt outcome finalizer already has an owner");
    this.owner = Symbol(this.outcome.identity.attemptOutcomeId);
    return this.owner;
  }

  async finalize(owner: symbol): Promise<AttemptSettlementReport> {
    if (typeof owner !== "symbol" || owner !== this.owner) {
      throw new Error("attempt outcome finalization requires the local owner token");
    }
    if (this.completed) {
      return { status: "duplicate", settledScopes: [...this.settled], pendingScopes: [] };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.settle();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async settle(): Promise<AttemptSettlementReport> {
    for (const effect of this.outcome.effects) {
      const hash = hashRecoveryScope(effect.scope);
      if (this.settled.has(hash)) continue;
      const state = await this.recovery.getState(effect.scope);
      if (!state) throw new Error(`recovery scope is unavailable: ${hash}`);
      const result = await this.recovery.recordAttemptOutcome({
        scope: effect.scope,
        expectedEpoch: state.epoch,
        attemptOutcomeId: this.outcome.identity.attemptOutcomeId,
        disposition: effect.disposition,
        durationMs: this.outcome.durationMs,
      });
      if (result.code !== "applied" && result.code !== "duplicate") {
        throw new Error(`recovery outcome rejected: ${result.code}`);
      }
      this.settled.add(hash);
    }
    if (this.outcome.providerLimit && !this.limitSettled) {
      if (this.outcome.providerLimit.disposition === "cooldown" && this.limits) {
        await this.limits.applyCooldown(this.outcome.providerLimit);
      }
      this.limitSettled = true;
    }
    this.completed = true;
    return { status: "applied", settledScopes: [...this.settled], pendingScopes: [] };
  }

  reportPending(): readonly string[] {
    return this.outcome.effects
      .map((effect) => hashRecoveryScope(effect.scope))
      .filter((hash) => !this.settled.has(hash));
  }
}

export function mayRetryAttempt(input: {
  readonly retrySafety: ClassifiedAttemptOutcome["retrySafety"];
  readonly upstreamCommitted: boolean;
  readonly downstreamCommitted: boolean;
}): boolean {
  if (input.downstreamCommitted || input.retrySafety === "never") return false;
  if (input.retrySafety === "idempotent") return true;
  return !input.upstreamCommitted;
}
