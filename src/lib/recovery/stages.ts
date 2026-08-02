export interface RecoveryStage {
  readonly index: number;
  readonly basisPoints: number;
  readonly rampWeightPercent: number | null;
}

export const RECOVERY_STAGES = [
  { index: 0, basisPoints: 500, rampWeightPercent: 20 },
  { index: 1, basisPoints: 2_500, rampWeightPercent: 20 },
  { index: 2, basisPoints: 5_000, rampWeightPercent: 20 },
  { index: 3, basisPoints: 7_500, rampWeightPercent: 40 },
  { index: 4, basisPoints: 10_000, rampWeightPercent: null },
] as const satisfies readonly RecoveryStage[];

export function recoveryStageAt(index: number): RecoveryStage {
  const stage = RECOVERY_STAGES[index];
  if (!stage) {
    throw new RangeError(`unknown recovery stage index: ${index}`);
  }
  return stage;
}

export function minimumRecoveryStageDurationMs(
  index: number,
  rampDurationMs: number,
  stableDurationMs: number
): number {
  if (!Number.isSafeInteger(rampDurationMs) || rampDurationMs <= 0) {
    throw new RangeError("rampDurationMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(stableDurationMs) || stableDurationMs <= 0) {
    throw new RangeError("stableDurationMs must be a positive safe integer");
  }
  const stage = recoveryStageAt(index);
  return stage.rampWeightPercent === null
    ? stableDurationMs
    : Math.ceil((rampDurationMs * stage.rampWeightPercent) / 100);
}
