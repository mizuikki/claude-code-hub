import type { AttemptIdentity, RecoveryScope } from "./contracts";
import { sortRecoveryScopes } from "./scope";

export interface CompositeState {
  readonly health: "closed" | "open" | "probing" | "half_open" | "recovering";
  readonly epoch: number;
  readonly automationPaused: boolean;
  readonly recoveryStageIndex: number;
}

export interface CompositeLease {
  readonly scope: RecoveryScope;
  readonly epoch: number;
  readonly token: string;
  readonly requestId: string;
  readonly attemptOutcomeId: string;
  readonly expiresAt: number;
}

export interface CompositeRecoveryService {
  getState(scope: RecoveryScope): Promise<CompositeState | null>;
  claimHalfOpenTrial(input: {
    scope: RecoveryScope;
    expectedEpoch: number;
    requestId: string;
    attemptOutcomeId: string;
    leaseMs: number;
  }): Promise<CompositeLease | { readonly code: string }>;
  releaseHalfOpenTrial(lease: CompositeLease): Promise<unknown>;
}

export type CompositeEvaluation =
  | { readonly code: "blocked"; readonly scope: RecoveryScope }
  | {
      readonly code: "eligible";
      readonly halfOpen: readonly { scope: RecoveryScope; epoch: number }[];
      readonly recovering: readonly {
        scope: RecoveryScope;
        epoch: number;
        stageIndex: number;
      }[];
    };

export async function evaluateCompositeScopes(
  service: CompositeRecoveryService,
  scopes: readonly RecoveryScope[]
): Promise<CompositeEvaluation> {
  const halfOpen: Array<{ scope: RecoveryScope; epoch: number }> = [];
  const recovering: Array<{ scope: RecoveryScope; epoch: number; stageIndex: number }> = [];
  for (const scope of sortRecoveryScopes(scopes)) {
    const state = await service.getState(scope);
    if (!state) return { code: "blocked", scope };
    if (state.automationPaused || state.health === "open" || state.health === "probing") {
      return { code: "blocked", scope };
    }
    if (state.health === "half_open") halfOpen.push({ scope, epoch: state.epoch });
    if (state.health === "recovering") {
      recovering.push({ scope, epoch: state.epoch, stageIndex: state.recoveryStageIndex });
    }
  }
  return { code: "eligible", halfOpen, recovering };
}

export async function claimCompositeHalfOpen(input: {
  readonly service: CompositeRecoveryService;
  readonly scopes: readonly RecoveryScope[];
  readonly identity: AttemptIdentity;
  readonly leaseMs: number;
  readonly maximumLeaseMs: number;
}): Promise<
  | { readonly code: "applied"; readonly leases: readonly CompositeLease[] }
  | { readonly code: "rejected"; readonly scope: RecoveryScope }
> {
  const leaseMs = Math.min(input.leaseMs, input.maximumLeaseMs);
  if (leaseMs <= 0) throw new RangeError("composite lease duration must be positive");
  const evaluation = await evaluateCompositeScopes(input.service, input.scopes);
  if (evaluation.code === "blocked") return { code: "rejected", scope: evaluation.scope };
  const leases: CompositeLease[] = [];
  for (const candidate of evaluation.halfOpen) {
    const result = await input.service.claimHalfOpenTrial({
      scope: candidate.scope,
      expectedEpoch: candidate.epoch,
      requestId: input.identity.requestId,
      attemptOutcomeId: input.identity.attemptOutcomeId,
      leaseMs,
    });
    if (!("token" in result)) {
      for (const lease of leases.reverse()) await input.service.releaseHalfOpenTrial(lease);
      return { code: "rejected", scope: candidate.scope };
    }
    leases.push(result);
  }
  return { code: "applied", leases };
}
