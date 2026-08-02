import type { RecoveryScope } from "./contracts";
import { recoveryLayerBucket } from "./deterministic-bucket";
import { recoveryStageAt } from "./stages";

export interface RecoveryAdmissionCandidate<T> {
  readonly value: T;
  readonly priority: number;
  readonly effectiveBasisPoints: number;
}

export interface RecoveryAdmissionResult<T> {
  readonly admitted: readonly T[];
  readonly priority: number | null;
  readonly bucket: number | null;
}

export interface RecoveryTrialAdmissionResult<T> extends RecoveryAdmissionResult<T> {
  readonly halfOpenTrial: boolean;
}

export function admitRecoveryPriorityLayer<T>(input: {
  readonly candidates: readonly RecoveryAdmissionCandidate<T>[];
  readonly routeKey: string;
}): RecoveryAdmissionResult<T> {
  const priorities = [...new Set(input.candidates.map((candidate) => candidate.priority))].sort(
    (left, right) => left - right
  );
  for (const priority of priorities) {
    const bucket = recoveryLayerBucket(input.routeKey, String(priority));
    const admitted = input.candidates
      .filter((candidate) => candidate.priority === priority)
      .filter((candidate) => bucket < candidate.effectiveBasisPoints)
      .map((candidate) => candidate.value);
    if (admitted.length > 0) return { admitted, priority, bucket };
  }
  return { admitted: [], priority: null, bucket: null };
}

export function admitRecoveryPriorityLayerWithTrials<T>(input: {
  readonly candidates: readonly (RecoveryAdmissionCandidate<T> & {
    readonly halfOpenEligible: boolean;
  })[];
  readonly routeKey: string;
}): RecoveryTrialAdmissionResult<T> {
  const priorities = [...new Set(input.candidates.map((candidate) => candidate.priority))].sort(
    (left, right) => left - right
  );
  for (const priority of priorities) {
    const bucket = recoveryLayerBucket(input.routeKey, String(priority));
    const layer = input.candidates.filter((candidate) => candidate.priority === priority);
    const admitted = layer
      .filter((candidate) => bucket < candidate.effectiveBasisPoints)
      .map((candidate) => candidate.value);
    if (admitted.length > 0) {
      return { admitted, priority, bucket, halfOpenTrial: false };
    }
    const trials = layer
      .filter((candidate) => candidate.halfOpenEligible)
      .map((candidate) => candidate.value);
    if (trials.length > 0) return { admitted: trials, priority, bucket, halfOpenTrial: true };
  }
  return { admitted: [], priority: null, bucket: null, halfOpenTrial: false };
}

export interface ProviderRecoveryCandidate {
  readonly id: number;
  readonly providerVendorId?: number | null;
  readonly providerType: string;
}

export interface ProviderRecoveryEvaluation {
  readonly effectiveBasisPoints: number;
  /** HALF_OPEN is admitted outside ordinary percentage routing and fenced at dispatch. */
  readonly halfOpenEligible?: boolean;
  readonly scopes?: readonly {
    readonly scope: RecoveryScope;
    readonly kind: RecoveryScope["kind"];
    readonly health: string;
    readonly basisPoints: number;
  }[];
  readonly shadowEffectiveBasisPoints?: number;
  readonly recovering: readonly {
    readonly scope: RecoveryScope;
    readonly epoch: number;
    readonly stageIndex: number;
  }[];
}

export type ProviderRecoveryEvaluator = (
  provider: ProviderRecoveryCandidate
) => Promise<ProviderRecoveryEvaluation>;

let providerEvaluator: ProviderRecoveryEvaluator | null = null;
let providerValidator:
  | ((provider: ProviderRecoveryCandidate, bucket: number) => Promise<boolean>)
  | null = null;
let providerShadowObserver:
  | ((input: {
      provider: ProviderRecoveryCandidate;
      evaluation: ProviderRecoveryEvaluation;
      legacyAllowed: boolean;
      v2Allowed: boolean;
    }) => void)
  | null = null;

export function setProviderRecoveryEvaluator(evaluator: ProviderRecoveryEvaluator | null): void {
  providerEvaluator = evaluator;
}

export function setProviderRecoveryValidator(
  validator: ((provider: ProviderRecoveryCandidate, bucket: number) => Promise<boolean>) | null
): void {
  providerValidator = validator;
}

export function setProviderRecoveryShadowObserver(observer: typeof providerShadowObserver): void {
  providerShadowObserver = observer;
}

export function observeProviderRecoveryShadow(input: {
  provider: ProviderRecoveryCandidate;
  evaluation: ProviderRecoveryEvaluation;
  legacyAllowed: boolean;
  v2Allowed: boolean;
}): void {
  providerShadowObserver?.(input);
}

export async function validateProviderRecovery(
  provider: ProviderRecoveryCandidate,
  bucket: number
): Promise<boolean> {
  return providerValidator ? providerValidator(provider, bucket) : true;
}

export async function evaluateProviderRecovery(
  provider: ProviderRecoveryCandidate
): Promise<ProviderRecoveryEvaluation> {
  return providerEvaluator
    ? providerEvaluator(provider)
    : { effectiveBasisPoints: 10_000, halfOpenEligible: false, recovering: [], scopes: [] };
}

export function effectiveRecoveryBasisPoints(
  states: readonly { health: string; recoveryStageIndex: number; automationPaused: boolean }[]
): number {
  if (
    states.some(
      (state) =>
        state.automationPaused ||
        state.health === "open" ||
        state.health === "probing" ||
        state.health === "half_open" ||
        state.health === "unknown"
    )
  ) {
    return 0;
  }
  const recovering = states.filter((state) => state.health === "recovering");
  return recovering.length === 0
    ? 10_000
    : Math.min(...recovering.map((state) => recoveryStageAt(state.recoveryStageIndex).basisPoints));
}
