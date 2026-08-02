import type { EndpointRecoveryPolicy, RecoveryScope } from "./contracts";
import { fingerprintDirectEndpoint, sortRecoveryScopes } from "./scope";

export interface RecoveryScopeDerivationInput {
  readonly vendorId: number;
  readonly providerId: number;
  readonly providerType: string;
  readonly endpoint:
    | { readonly kind: "managed"; readonly endpointId: number }
    | { readonly kind: "direct"; readonly url: string; readonly endpointFamilyId: string };
  readonly modelFamily: string | null;
  readonly transport: string;
  readonly policy: EndpointRecoveryPolicy;
}

export interface DerivedRecoveryScopes {
  readonly ordered: readonly RecoveryScope[];
  readonly vendorType: RecoveryScope;
  readonly provider: RecoveryScope;
  readonly endpoint: RecoveryScope;
  readonly capability: RecoveryScope | null;
}

export function deriveRecoveryScopes(input: RecoveryScopeDerivationInput): DerivedRecoveryScopes {
  const vendorType: RecoveryScope = {
    kind: "vendor-type",
    vendorId: input.vendorId,
    providerType: input.providerType,
  };
  const provider: RecoveryScope = { kind: "provider", providerId: input.providerId };
  const endpoint: RecoveryScope = {
    kind: "endpoint",
    providerId: input.providerId,
    endpoint:
      input.endpoint.kind === "managed"
        ? { kind: "managed", endpointId: input.endpoint.endpointId }
        : fingerprintDirectEndpoint(input.endpoint.url, input.endpoint.endpointFamilyId),
  };
  const capability: RecoveryScope | null = input.modelFamily
    ? {
        kind: "capability",
        providerId: input.providerId,
        modelFamily: input.modelFamily,
        transport: input.transport,
      }
    : null;
  return {
    vendorType,
    provider,
    endpoint,
    capability,
    ordered: sortRecoveryScopes(
      capability ? [vendorType, provider, endpoint, capability] : [vendorType, provider, endpoint]
    ),
  };
}
