import { createHash } from "node:crypto";
import type { DirectEndpointRef, RecoveryScope } from "./contracts";

const CANONICAL_SCOPE_VERSION = 1;
const CANONICAL_DIRECT_ENDPOINT_VERSION = 1;
const NORMALIZED_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?$/;

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function normalizeRecoveryIdentifier(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!NORMALIZED_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must contain only canonical ASCII identifier characters`);
  }
  return normalized;
}

export function canonicalizeRecoveryScope(scope: RecoveryScope): string {
  switch (scope.kind) {
    case "vendor-type":
      assertPositiveInteger(scope.vendorId, "vendorId");
      return JSON.stringify([
        "recovery-scope",
        CANONICAL_SCOPE_VERSION,
        "vendor-type",
        scope.vendorId,
        normalizeRecoveryIdentifier(scope.providerType, "providerType"),
      ]);
    case "provider":
      assertPositiveInteger(scope.providerId, "providerId");
      return JSON.stringify([
        "recovery-scope",
        CANONICAL_SCOPE_VERSION,
        "provider",
        scope.providerId,
      ]);
    case "endpoint": {
      assertPositiveInteger(scope.providerId, "providerId");
      if (scope.endpoint.kind === "managed") {
        assertPositiveInteger(scope.endpoint.endpointId, "endpointId");
        return JSON.stringify([
          "recovery-scope",
          CANONICAL_SCOPE_VERSION,
          "endpoint",
          scope.providerId,
          "managed",
          scope.endpoint.endpointId,
        ]);
      }
      if (!/^[a-f0-9]{64}$/.test(scope.endpoint.endpointHash)) {
        throw new TypeError("endpointHash must be a lowercase SHA-256 hex digest");
      }
      return JSON.stringify([
        "recovery-scope",
        CANONICAL_SCOPE_VERSION,
        "endpoint",
        scope.providerId,
        "direct",
        scope.endpoint.endpointHash,
      ]);
    }
    case "capability":
      assertPositiveInteger(scope.providerId, "providerId");
      return JSON.stringify([
        "recovery-scope",
        CANONICAL_SCOPE_VERSION,
        "capability",
        scope.providerId,
        normalizeRecoveryIdentifier(scope.modelFamily, "modelFamily"),
        normalizeRecoveryIdentifier(scope.transport, "transport"),
      ]);
  }
}

export function hashRecoveryScope(scope: RecoveryScope): string {
  return createHash("sha256").update(canonicalizeRecoveryScope(scope), "utf8").digest("hex");
}

export function canonicalizeDirectEndpoint(rawUrl: string, endpointFamilyId: string): string {
  const url = new URL(rawUrl);
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new TypeError("direct endpoint URL must use HTTP or HTTPS");
  }

  const family = normalizeRecoveryIdentifier(endpointFamilyId, "endpointFamilyId");
  const effectivePort = url.port || (scheme === "https:" ? "443" : "80");
  return JSON.stringify([
    "direct-endpoint",
    CANONICAL_DIRECT_ENDPOINT_VERSION,
    scheme.slice(0, -1),
    url.hostname.toLowerCase(),
    effectivePort,
    family,
  ]);
}

export function fingerprintDirectEndpoint(
  rawUrl: string,
  endpointFamilyId: string
): DirectEndpointRef {
  const canonical = canonicalizeDirectEndpoint(rawUrl, endpointFamilyId);
  return {
    kind: "direct",
    endpointHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

export function compareRecoveryScopes(left: RecoveryScope, right: RecoveryScope): number {
  const order = { "vendor-type": 0, provider: 1, endpoint: 2, capability: 3 } as const;
  const kindOrder = order[left.kind] - order[right.kind];
  return (
    kindOrder || canonicalizeRecoveryScope(left).localeCompare(canonicalizeRecoveryScope(right))
  );
}

export function sortRecoveryScopes(scopes: readonly RecoveryScope[]): RecoveryScope[] {
  return [...scopes].sort(compareRecoveryScopes);
}
