import type { RecoveryAuthorityMode, RecoveryHealth, RecoveryScope } from "./contracts";

export type LegacyCircuitHealth = "closed" | "open" | "half-open" | "malformed" | "unknown";

export interface RecoveryRoutingDecision {
  readonly allowed: boolean;
  readonly health: RecoveryHealth | "unknown";
  readonly epoch: number | null;
}

export interface RecoveryShadowDiff {
  readonly scope: RecoveryScope;
  readonly legacyAllowed: boolean;
  readonly v2Allowed: boolean;
  readonly legacyHealth: LegacyCircuitHealth;
  readonly v2Health: RecoveryHealth | "unknown";
  readonly decisionKind?: "state" | "routing";
  readonly v2BasisPoints?: number;
}

export function importLegacyHealth(health: LegacyCircuitHealth): RecoveryHealth {
  if (health === "closed") return "closed";
  // HALF_OPEN and uncertain legacy data have no lease/epoch proof, so cutover stays restrictive.
  return "open";
}

export function exportV2Health(health: RecoveryHealth | "unknown"): LegacyCircuitHealth {
  return health === "closed" ? "closed" : "open";
}

export type LegacyRollbackTarget =
  | { readonly kind: "provider"; readonly providerId: number }
  | { readonly kind: "endpoint"; readonly endpointId: number }
  | { readonly kind: "vendor-type"; readonly vendorId: number; readonly providerType: string };

export function legacyRollbackTarget(scope: RecoveryScope): LegacyRollbackTarget {
  if (scope.kind === "vendor-type") return scope;
  if (scope.kind === "endpoint" && scope.endpoint.kind === "managed") {
    return { kind: "endpoint", endpointId: scope.endpoint.endpointId };
  }
  return { kind: "provider", providerId: scope.providerId };
}

export function legacyAllows(health: LegacyCircuitHealth): boolean {
  return health === "closed" || health === "half-open";
}

export function v2Allows(health: RecoveryHealth | "unknown"): boolean {
  return health === "closed" || health === "half_open" || health === "recovering";
}

export function selectRecoveryAuthorityDecision(input: {
  readonly mode: RecoveryAuthorityMode;
  readonly legacyHealth: LegacyCircuitHealth;
  readonly v2: RecoveryRoutingDecision;
}): { readonly decision: RecoveryRoutingDecision; readonly shadowDiff: boolean } {
  const legacyDecision: RecoveryRoutingDecision = {
    allowed: legacyAllows(input.legacyHealth),
    health: importLegacyHealth(input.legacyHealth),
    epoch: null,
  };
  const shadowDiff = legacyDecision.allowed !== input.v2.allowed;
  return {
    decision: input.mode === "enforce" ? input.v2 : legacyDecision,
    shadowDiff: input.mode === "shadow" && shadowDiff,
  };
}

export class BoundedShadowDiffBuffer {
  private readonly entries: RecoveryShadowDiff[] = [];

  constructor(private readonly capacity = 1_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("shadow diff capacity must be a positive safe integer");
    }
  }

  push(diff: RecoveryShadowDiff): void {
    this.entries.push(diff);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  drain(): readonly RecoveryShadowDiff[] {
    return this.entries.splice(0);
  }
}

export type RecoveryRolloutProof = "fleet_replaced" | "maintenance_window";

export function bindingAuthorityTransitionAllowed(input: {
  current: "legacy" | "shadow" | "v2_dual_write" | "v2_only";
  next: "legacy" | "shadow" | "v2_dual_write" | "v2_only";
}): boolean {
  if (input.current === input.next) return true;
  const transitions = new Set([
    "legacy:shadow",
    "shadow:legacy",
    "shadow:v2_dual_write",
    "v2_dual_write:shadow",
    "v2_dual_write:v2_only",
    // Rollback must first restore atomic scalar dual-write for all live bindings.
    "v2_only:v2_dual_write",
  ]);
  return transitions.has(`${input.current}:${input.next}`);
}

export function authorityTransitionRequiresProof(input: {
  currentRecovery: RecoveryAuthorityMode;
  nextRecovery: RecoveryAuthorityMode;
  currentBinding: "legacy" | "shadow" | "v2_dual_write" | "v2_only";
  nextBinding: "legacy" | "shadow" | "v2_dual_write" | "v2_only";
}): boolean {
  const recoveryProductionTransition =
    input.currentRecovery !== input.nextRecovery &&
    (input.currentRecovery === "enforce" || input.nextRecovery === "enforce");
  const productionBindingModes = new Set(["v2_dual_write", "v2_only"]);
  const bindingProductionTransition =
    input.currentBinding !== input.nextBinding &&
    (productionBindingModes.has(input.currentBinding) ||
      productionBindingModes.has(input.nextBinding));
  return recoveryProductionTransition || bindingProductionTransition;
}
