import { describe, expect, it, vi } from "vitest";
import { RecoveryDegradationGate, RecoveryDegradedReconciler } from "@/lib/recovery/degradation";
import { RecoveryStrictnessCache } from "@/lib/recovery/strictness-cache";

const scope = { kind: "provider" as const, providerId: 8 };

describe("recovery degradation", () => {
  it("allows only pre-outage cached CLOSED stateless routing", async () => {
    const cache = new RecoveryStrictnessCache();
    cache.putAuthoritative(scope, "closed", 1, 100);
    const writer = { upsert: vi.fn(async () => undefined) };
    const gate = new RecoveryDegradationGate(cache, writer, "instance");
    gate.enter(200);
    expect(gate.mayRouteStateless(scope)).toBe(true);
    await gate.observeLocalOpen(scope, "timeout", 250);
    expect(gate.mayRouteStateless(scope)).toBe(false);
    expect(writer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: "timeout", sourceInstanceId: "instance" })
    );
    expect(gate.clearAfterFreshAuthorityRead()).toBe(false);
  });

  it("merges durable evidence into a fresh OPEN epoch before clearing degradation", async () => {
    const cache = new RecoveryStrictnessCache();
    const gate = new RecoveryDegradationGate(cache, { upsert: vi.fn() }, "instance");
    gate.enter(100);
    const store = {
      list: vi.fn(async () => [{ scopeHash: "a".repeat(64), scope, failureClass: "timeout" }]),
      markReconciled: vi.fn(async () => 1),
    };
    const recovery = {
      getState: vi
        .fn()
        .mockResolvedValueOnce({ epoch: 4, health: "closed" })
        .mockResolvedValueOnce({ epoch: 5, health: "open" }),
      initializeScope: vi.fn(),
      administrate: vi.fn(async () => ({ code: "applied" })),
    };
    const reconciler = new RecoveryDegradedReconciler(store, recovery, gate);
    expect(await reconciler.reconcile()).toBe(1);
    expect(recovery.administrate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "force_open", expectedEpoch: 4 })
    );
    expect(gate.clearAfterFreshAuthorityRead()).toBe(true);
  });

  it("stays degraded when PostgreSQL acknowledgement is uncertain", async () => {
    const gate = new RecoveryDegradationGate(
      new RecoveryStrictnessCache(),
      { upsert: vi.fn() },
      "instance"
    );
    gate.enter();
    const reconciler = new RecoveryDegradedReconciler(
      {
        list: async () => [{ scopeHash: "b".repeat(64), scope, failureClass: "timeout" }],
        markReconciled: async () => 0,
      },
      {
        getState: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ epoch: 1, health: "open" }),
        initializeScope: async () => ({ code: "applied" }),
        administrate: vi.fn(),
      },
      gate
    );
    await expect(reconciler.reconcile()).rejects.toThrow("acknowledgement is uncertain");
    expect(gate.degraded).toBe(true);
  });

  it("rejects a stale Redis CLOSED snapshot after durable OPEN reconciliation", async () => {
    const gate = new RecoveryDegradationGate(
      new RecoveryStrictnessCache(),
      { upsert: vi.fn() },
      "instance"
    );
    gate.enter();
    const reconciler = new RecoveryDegradedReconciler(
      {
        list: async () => [{ scopeHash: "c".repeat(64), scope, failureClass: "timeout" }],
        markReconciled: vi.fn(),
      },
      {
        getState: vi
          .fn()
          .mockResolvedValueOnce({ epoch: 4, health: "closed" })
          .mockResolvedValueOnce({ epoch: 4, health: "closed" }),
        initializeScope: vi.fn(),
        administrate: async () => ({ code: "applied" }),
      },
      gate
    );
    await expect(reconciler.reconcile()).rejects.toThrow("fresh authority read rejected");
    expect(gate.clearAfterFreshAuthorityRead()).toBe(false);
  });
});
