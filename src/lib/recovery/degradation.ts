import type { RecoveryScope } from "./contracts";
import type { RecoveryStrictnessCache } from "./strictness-cache";

export interface DegradedEvidenceWriter {
  upsert(input: {
    readonly scope: RecoveryScope;
    readonly observedAt: Date;
    readonly failureClass: string;
    readonly sourceInstanceId: string;
  }): Promise<unknown>;
}

export class RecoveryDegradationGate {
  private outageStartedAt: number | null = null;
  private reconciliationComplete = false;
  private freshAuthorityReadComplete = false;

  constructor(
    private readonly cache: RecoveryStrictnessCache,
    private readonly evidence: DegradedEvidenceWriter,
    private readonly sourceInstanceId: string
  ) {}

  enter(now = Date.now()): void {
    this.outageStartedAt ??= now;
    this.reconciliationComplete = false;
    this.freshAuthorityReadComplete = false;
  }

  get degraded(): boolean {
    return this.outageStartedAt !== null;
  }

  mayRouteStateless(scope: RecoveryScope): boolean {
    return (
      this.outageStartedAt !== null && this.cache.canRouteWhileDegraded(scope, this.outageStartedAt)
    );
  }

  async observeLocalOpen(
    scope: RecoveryScope,
    failureClass: string,
    now = Date.now()
  ): Promise<void> {
    const currentEpoch = this.cache.get(scope)?.epoch ?? 0;
    this.cache.markOpen(scope, currentEpoch, now);
    await this.evidence.upsert({
      scope,
      observedAt: new Date(now),
      failureClass,
      sourceInstanceId: this.sourceInstanceId,
    });
  }

  markReconciled(): void {
    this.reconciliationComplete = true;
  }

  markFreshAuthorityRead(): void {
    this.freshAuthorityReadComplete = true;
  }

  clearAfterFreshAuthorityRead(): boolean {
    if (!this.reconciliationComplete || !this.freshAuthorityReadComplete) return false;
    this.outageStartedAt = null;
    this.reconciliationComplete = false;
    this.freshAuthorityReadComplete = false;
    return true;
  }
}

export interface PendingDegradedEvidence {
  readonly scopeHash: string;
  readonly scope: RecoveryScope;
  readonly failureClass: string;
}

export interface DegradedEvidenceStore {
  list(limit: number): Promise<readonly PendingDegradedEvidence[]>;
  markReconciled(scopeHashes: readonly string[]): Promise<number>;
}

export interface DegradedRecoveryService {
  getState(
    scope: RecoveryScope
  ): Promise<{ readonly epoch: number; readonly health?: string } | null>;
  initializeScope(scope: RecoveryScope, health: "open"): Promise<{ readonly code: string }>;
  administrate(input: {
    readonly scope: RecoveryScope;
    readonly action: "force_open";
    readonly expectedEpoch: number;
    readonly reason: string;
  }): Promise<{ readonly code: string }>;
}

export class RecoveryDegradedReconciler {
  constructor(
    private readonly store: DegradedEvidenceStore,
    private readonly recovery: DegradedRecoveryService,
    private readonly gate: RecoveryDegradationGate,
    private readonly verifyFreshAuthorityRead: (() => Promise<void>) | null = null
  ) {}

  async reconcile(limit = 100): Promise<number> {
    const evidence = await this.store.list(limit);
    const applied: string[] = [];
    for (const item of evidence) {
      const state = await this.recovery.getState(item.scope);
      const result = state
        ? await this.recovery.administrate({
            scope: item.scope,
            action: "force_open",
            expectedEpoch: state.epoch,
            reason: `degraded_${item.failureClass}`,
          })
        : await this.recovery.initializeScope(item.scope, "open");
      if (result.code !== "applied" && result.code !== "exists") {
        throw new Error(`degraded evidence reconciliation rejected: ${result.code}`);
      }
      const fresh = await this.recovery.getState(item.scope);
      if (
        fresh?.health !== "open" ||
        (state !== null && result.code === "applied" && fresh.epoch <= state.epoch)
      ) {
        throw new Error("degraded evidence fresh authority read rejected");
      }
      applied.push(item.scopeHash);
    }
    if (applied.length > 0) {
      const marked = await this.store.markReconciled(applied);
      if (marked !== applied.length)
        throw new Error("degraded evidence acknowledgement is uncertain");
    }
    await this.verifyFreshAuthorityRead?.();
    this.gate.markFreshAuthorityRead();
    this.gate.markReconciled();
    return applied.length;
  }
}
