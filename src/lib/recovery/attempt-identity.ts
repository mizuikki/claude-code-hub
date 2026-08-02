import { randomUUID } from "node:crypto";
import type { AttemptIdentity, AttemptKind } from "./contracts";

type IdFactory = () => string;

export function createRequestId(idFactory: IdFactory = randomUUID): string {
  return `request_${idFactory()}`;
}

export function createAttemptIdentity(
  requestId: string,
  attemptNumber: number,
  attemptKind: AttemptKind,
  idFactory: IdFactory = randomUUID
): AttemptIdentity {
  if (!requestId) {
    throw new TypeError("requestId must be non-empty");
  }
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 0) {
    throw new RangeError("attemptNumber must be a non-negative safe integer");
  }
  return {
    requestId,
    attemptOutcomeId: `attempt_${idFactory()}`,
    attemptNumber,
    attemptKind,
  };
}
