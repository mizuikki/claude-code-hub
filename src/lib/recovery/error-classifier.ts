import type {
  EndpointRecoveryPolicy,
  ProviderLimitEffect,
  ProviderLimitScope,
  RecoveryDisposition,
  RecoveryEffect,
} from "./contracts";
import type { DerivedRecoveryScopes } from "./scope-derivation";

export type RecoveryFaultClass =
  | "success"
  | "endpoint_connectivity"
  | "vendor_transport"
  | "provider_credential"
  | "provider_service"
  | "capability"
  | "rate_limit"
  | "client"
  | "local";

export interface RecoveryClassificationInput {
  readonly faultClass: RecoveryFaultClass;
  readonly policy: EndpointRecoveryPolicy;
  readonly scopes: DerivedRecoveryScopes;
  readonly providerLimitScope: ProviderLimitScope;
  readonly retryAfterMs?: number | null;
  readonly reason: string;
  readonly hard?: boolean;
}

export interface RecoveryClassification {
  readonly effects: readonly RecoveryEffect[];
  readonly providerLimit: ProviderLimitEffect | null;
}

export class ConsecutiveHardFailureTracker {
  private readonly counts = new Map<string, number>();

  classify(scopeKey: string, status: number, threshold: number): boolean {
    if (!Number.isSafeInteger(threshold) || threshold < 1) {
      throw new RangeError("hard failure threshold must be a positive safe integer");
    }
    if (status < 500 || status > 599) {
      this.counts.delete(scopeKey);
      return false;
    }
    const count = (this.counts.get(scopeKey) ?? 0) + 1;
    this.counts.set(scopeKey, count);
    return count >= threshold;
  }

  clear(scopeKey: string): void {
    this.counts.delete(scopeKey);
  }
}

function effect(
  scope: RecoveryEffect["scope"],
  disposition: RecoveryDisposition,
  reason: string
): RecoveryEffect {
  return { scope, disposition, reason };
}

export function classifyRecoveryEffects(
  input: RecoveryClassificationInput
): RecoveryClassification {
  const disposition: RecoveryDisposition = input.hard ? "hard_failure" : "transient_failure";
  switch (input.faultClass) {
    case "success":
      if (input.policy.recoveryEvidence === "none") return { effects: [], providerLimit: null };
      if (input.policy.recoveryEvidence === "connectivity") {
        return {
          effects: [effect(input.scopes.endpoint, "success", input.reason)],
          providerLimit: null,
        };
      }
      return {
        effects: input.scopes.ordered.map((scope) => effect(scope, "success", input.reason)),
        providerLimit: null,
      };
    case "endpoint_connectivity":
      return {
        effects: [effect(input.scopes.endpoint, disposition, input.reason)],
        providerLimit: null,
      };
    case "vendor_transport":
      return {
        effects: [
          effect(input.scopes.vendorType, disposition, input.reason),
          effect(input.scopes.endpoint, disposition, input.reason),
        ],
        providerLimit: null,
      };
    case "provider_credential":
    case "provider_service":
      return {
        effects: [effect(input.scopes.provider, disposition, input.reason)],
        providerLimit: null,
      };
    case "capability":
      return {
        effects: input.scopes.capability
          ? [effect(input.scopes.capability, disposition, input.reason)]
          : [],
        providerLimit: null,
      };
    case "rate_limit":
      return {
        effects: [],
        providerLimit: {
          disposition: "cooldown",
          scope: input.providerLimitScope,
          retryAfterMs: Math.max(0, Math.trunc(input.retryAfterMs ?? 0)),
          reason: input.reason,
        },
      };
    case "client":
    case "local":
      return { effects: [], providerLimit: null };
  }
}
