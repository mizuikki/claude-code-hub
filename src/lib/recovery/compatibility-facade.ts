import {
  BoundedShadowDiffBuffer,
  type LegacyCircuitHealth,
  selectRecoveryAuthorityDecision,
  v2Allows,
} from "./authority";
import type {
  AttemptIdentity,
  RecoveryAuthorityMode,
  RecoveryDisposition,
  RecoveryScope,
} from "./contracts";
import { hashRecoveryScope } from "./scope";

export interface ScopedRecoveryCompatibilityService {
  getState(scope: RecoveryScope): Promise<{ health: string; epoch: number } | null>;
  initializeScope(scope: RecoveryScope, health: "closed" | "open"): Promise<unknown>;
  recordAttemptOutcome(input: {
    scope: RecoveryScope;
    expectedEpoch: number;
    attemptOutcomeId: string;
    disposition: RecoveryDisposition;
    durationMs: number;
  }): Promise<unknown>;
}

export interface CompatibilityOutcome {
  readonly scope: RecoveryScope;
  readonly disposition: RecoveryDisposition;
  readonly identity: AttemptIdentity;
  readonly durationMs: number;
}

export class RecoveryCompatibilityFacade {
  readonly shadowDiffs: BoundedShadowDiffBuffer;
  private readonly finalizedAttempts = new Map<
    string,
    { scopes: Set<string>; touchedAt: number }
  >();

  constructor(
    private readonly mode: RecoveryAuthorityMode,
    private readonly production: ScopedRecoveryCompatibilityService,
    private readonly shadow: ScopedRecoveryCompatibilityService,
    shadowDiffCapacity = 1_000
  ) {
    this.shadowDiffs = new BoundedShadowDiffBuffer(shadowDiffCapacity);
  }

  async isOpen(scope: RecoveryScope, legacyHealth: LegacyCircuitHealth): Promise<boolean> {
    if (this.mode === "legacy") return legacyHealth === "open" || legacyHealth === "unknown";
    const service = this.mode === "shadow" ? this.shadow : this.production;
    const snapshot = await service.getState(scope);
    const v2Health =
      snapshot?.health === "closed" ||
      snapshot?.health === "open" ||
      snapshot?.health === "probing" ||
      snapshot?.health === "half_open" ||
      snapshot?.health === "recovering"
        ? snapshot.health
        : "unknown";
    const selected = selectRecoveryAuthorityDecision({
      mode: this.mode,
      legacyHealth,
      v2: { allowed: v2Allows(v2Health), health: v2Health, epoch: snapshot?.epoch ?? null },
    });
    if (selected.shadowDiff) {
      this.shadowDiffs.push({
        scope,
        legacyAllowed: legacyHealth === "closed" || legacyHealth === "half-open",
        v2Allowed: v2Allows(v2Health),
        legacyHealth,
        v2Health,
      });
    }
    return !selected.decision.allowed;
  }

  async mirrorOutcome(outcome: CompatibilityOutcome): Promise<void> {
    if (this.mode === "legacy") return;
    const now = Date.now();
    if (this.finalizedAttempts.size > 10_000) {
      for (const [attemptId, entry] of this.finalizedAttempts) {
        if (now - entry.touchedAt > 10 * 60_000) this.finalizedAttempts.delete(attemptId);
      }
    }
    const finalized = this.finalizedAttempts.get(outcome.identity.attemptOutcomeId) ?? {
      scopes: new Set<string>(),
      touchedAt: now,
    };
    const scopeHash = hashRecoveryScope(outcome.scope);
    if (finalized.scopes.has(scopeHash)) return;
    finalized.touchedAt = now;
    this.finalizedAttempts.set(outcome.identity.attemptOutcomeId, finalized);
    const service = this.mode === "shadow" ? this.shadow : this.production;
    let snapshot = await service.getState(outcome.scope);
    if (!snapshot) {
      await service.initializeScope(outcome.scope, "closed");
      snapshot = await service.getState(outcome.scope);
    }
    if (!snapshot) return;
    const result = await service.recordAttemptOutcome({
      scope: outcome.scope,
      expectedEpoch: snapshot.epoch,
      attemptOutcomeId: outcome.identity.attemptOutcomeId,
      disposition: outcome.disposition,
      durationMs: outcome.durationMs,
    });
    if (
      !result ||
      typeof result !== "object" ||
      !("code" in result) ||
      ((result as { code: string }).code !== "applied" &&
        (result as { code: string }).code !== "duplicate")
    ) {
      return;
    }
    finalized.scopes.add(scopeHash);
  }

  recordRoutingDecision(input: {
    scopes: readonly {
      scope: RecoveryScope;
      health: string;
      basisPoints: number;
    }[];
    legacyAllowed: boolean;
    v2Allowed: boolean;
  }): void {
    if (this.mode !== "shadow" || input.legacyAllowed === input.v2Allowed) return;
    for (const entry of input.scopes) {
      this.shadowDiffs.push({
        scope: entry.scope,
        legacyAllowed: input.legacyAllowed,
        v2Allowed: input.v2Allowed,
        legacyHealth: input.legacyAllowed ? "closed" : "open",
        v2Health:
          entry.health === "closed" ||
          entry.health === "open" ||
          entry.health === "probing" ||
          entry.health === "half_open" ||
          entry.health === "recovering"
            ? entry.health
            : "unknown",
        decisionKind: "routing",
        v2BasisPoints: entry.basisPoints,
      });
    }
  }
}

let activeFacade: RecoveryCompatibilityFacade | null = null;

export function setRecoveryCompatibilityFacade(facade: RecoveryCompatibilityFacade | null): void {
  activeFacade = facade;
}

export function getRecoveryCompatibilityFacade(): RecoveryCompatibilityFacade | null {
  return activeFacade;
}
