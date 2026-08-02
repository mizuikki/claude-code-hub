import { describe, expect, it, vi } from "vitest";
import {
  authorityTransitionRequiresProof,
  bindingAuthorityTransitionAllowed,
  exportV2Health,
  importLegacyHealth,
  legacyRollbackTarget,
  selectRecoveryAuthorityDecision,
} from "@/lib/recovery/authority";
import { RecoveryCompatibilityFacade } from "@/lib/recovery/compatibility-facade";
import { ConsecutiveHardFailureTracker } from "@/lib/recovery/error-classifier";

const scope = { kind: "provider" as const, providerId: 7 };

function service(health: "closed" | "open" = "closed") {
  return {
    getState: vi.fn(async () => ({ health, epoch: 3 })),
    initializeScope: vi.fn(async () => undefined),
    recordAttemptOutcome: vi.fn(async () => undefined),
  };
}

describe("recovery authority", () => {
  it("imports and exports uncertain states conservatively", () => {
    expect(importLegacyHealth("half-open")).toBe("open");
    expect(importLegacyHealth("malformed")).toBe("open");
    expect(exportV2Health("recovering")).toBe("open");
    expect(exportV2Health("unknown")).toBe("open");
    expect(exportV2Health("closed")).toBe("closed");
  });

  it("exports every non-legacy scope to a restrictive legacy owner", () => {
    expect(
      legacyRollbackTarget({
        kind: "endpoint",
        providerId: 7,
        endpoint: { kind: "direct", endpointHash: "a".repeat(64) },
      })
    ).toEqual({ kind: "provider", providerId: 7 });
    expect(
      legacyRollbackTarget({
        kind: "capability",
        providerId: 8,
        modelFamily: "model",
        transport: "http",
      })
    ).toEqual({ kind: "provider", providerId: 8 });
    expect(
      legacyRollbackTarget({
        kind: "endpoint",
        providerId: 9,
        endpoint: { kind: "managed", endpointId: 11 },
      })
    ).toEqual({ kind: "endpoint", endpointId: 11 });
  });

  it("does not let shadow decisions affect routing", () => {
    expect(
      selectRecoveryAuthorityDecision({
        mode: "shadow",
        legacyHealth: "closed",
        v2: { allowed: false, health: "open", epoch: 4 },
      })
    ).toEqual({
      decision: { allowed: true, health: "closed", epoch: null },
      shadowDiff: true,
    });
  });

  it("uses isolated services and never dispatches upstream work in shadow", async () => {
    const production = service("closed");
    const shadow = service("open");
    const facade = new RecoveryCompatibilityFacade("shadow", production, shadow);
    expect(await facade.isOpen(scope, "closed")).toBe(false);
    expect(production.getState).not.toHaveBeenCalled();
    expect(shadow.getState).toHaveBeenCalledOnce();
    expect(facade.shadowDiffs.drain()).toHaveLength(1);
  });

  it("records bounded shadow routing differences without dispatching work", () => {
    const facade = new RecoveryCompatibilityFacade("shadow", service(), service(), 1);
    facade.recordRoutingDecision({
      scopes: [{ scope, health: "recovering", basisPoints: 1_000 }],
      legacyAllowed: true,
      v2Allowed: false,
    });
    facade.recordRoutingDecision({
      scopes: [{ scope, health: "open", basisPoints: 0 }],
      legacyAllowed: true,
      v2Allowed: false,
    });
    expect(facade.shadowDiffs.drain()).toEqual([
      expect.objectContaining({
        decisionKind: "routing",
        legacyAllowed: true,
        v2Allowed: false,
        v2BasisPoints: 0,
      }),
    ]);
  });

  it("requires consecutive 5xx failures before hard classification", () => {
    const tracker = new ConsecutiveHardFailureTracker();
    expect(tracker.classify("provider:1", 500, 3)).toBe(false);
    expect(tracker.classify("provider:1", 503, 3)).toBe(false);
    expect(tracker.classify("provider:1", 502, 3)).toBe(true);
    expect(tracker.classify("provider:1", 200, 3)).toBe(false);
    expect(tracker.classify("provider:1", 500, 3)).toBe(false);
  });

  it("requires deployment proof for production authority transitions", () => {
    expect(
      authorityTransitionRequiresProof({
        currentRecovery: "shadow",
        nextRecovery: "enforce",
        currentBinding: "shadow",
        nextBinding: "shadow",
      })
    ).toBe(true);
    expect(
      authorityTransitionRequiresProof({
        currentRecovery: "legacy",
        nextRecovery: "shadow",
        currentBinding: "legacy",
        nextBinding: "shadow",
      })
    ).toBe(false);
    expect(
      authorityTransitionRequiresProof({
        currentRecovery: "enforce",
        nextRecovery: "legacy",
        currentBinding: "v2_only",
        nextBinding: "legacy",
      })
    ).toBe(true);
  });

  it("requires staged binding authority rollout and rollback", () => {
    expect(bindingAuthorityTransitionAllowed({ current: "legacy", next: "shadow" })).toBe(true);
    expect(bindingAuthorityTransitionAllowed({ current: "shadow", next: "v2_dual_write" })).toBe(
      true
    );
    expect(bindingAuthorityTransitionAllowed({ current: "v2_dual_write", next: "v2_only" })).toBe(
      true
    );
    expect(bindingAuthorityTransitionAllowed({ current: "v2_only", next: "v2_dual_write" })).toBe(
      true
    );
    expect(bindingAuthorityTransitionAllowed({ current: "v2_only", next: "legacy" })).toBe(false);
    expect(bindingAuthorityTransitionAllowed({ current: "legacy", next: "v2_only" })).toBe(false);
  });
});
