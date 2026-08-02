import { createHash } from "node:crypto";

export const BUCKET_COUNT = 10_000;
export const UINT32_RANGE = 0x1_0000_0000;
export const BUCKET_REJECTION_LIMIT = Math.floor(UINT32_RANGE / BUCKET_COUNT) * BUCKET_COUNT;

type DigestFactory = (input: string) => Uint8Array;

function sha256(input: string): Uint8Array {
  return createHash("sha256").update(input, "utf8").digest();
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1_000000 +
    bytes[offset + 1] * 0x1_0000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function frameBucketInput(domain: string, key: string, counter: number): string {
  return `${domain.length}:${domain}:${key.length}:${key}:${counter}`;
}

export function bucket10000WithDigest(
  domain: string,
  key: string,
  digestFactory: DigestFactory
): number {
  if (!domain || !key) {
    throw new TypeError("bucket domain and key must be non-empty");
  }

  for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter += 1) {
    const digest = digestFactory(frameBucketInput(domain, key, counter));
    if (digest.byteLength === 0 || digest.byteLength % 4 !== 0) {
      throw new TypeError("bucket digest must contain a non-empty sequence of 32-bit words");
    }
    for (let offset = 0; offset < digest.byteLength; offset += 4) {
      const value = readUint32BigEndian(digest, offset);
      if (value < BUCKET_REJECTION_LIMIT) {
        return value % BUCKET_COUNT;
      }
    }
  }

  throw new Error("unreachable bucket counter exhaustion");
}

export function bucket10000(domain: string, key: string): number {
  return bucket10000WithDigest(domain, key, sha256);
}

export function recoveryLayerBucket(routeKey: string, layerIdentity: string): number {
  return bucket10000("recovery-layer-v1", `${routeKey}:${layerIdentity}`);
}

export function sessionFailbackBucket(sessionId: string): number {
  return bucket10000("session-failback-v1", sessionId);
}

export function isBasisPointBucketAdmitted(bucket: number, basisPoints: number): boolean {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKET_COUNT) {
    throw new RangeError("bucket must be an integer from 0 through 9999");
  }
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BUCKET_COUNT) {
    throw new RangeError("basisPoints must be an integer from 0 through 10000");
  }
  return bucket < basisPoints;
}

export function failbackRolloutBasisPoints(rolloutPercent: number): number {
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new RangeError("rolloutPercent must be an integer from 0 through 100");
  }
  return rolloutPercent * 100;
}
