import { describe, expect, it, vi } from "vitest";
import { CODE_PROBE_BUDGET_DEFAULTS } from "@/lib/recovery/config";
import {
  deterministicProbeBackoffMs,
  parseCanonicalRecoveryScope,
  RecoveryDueScheduler,
} from "@/lib/recovery/probe-scheduler";
import { canonicalizeRecoveryScope } from "@/lib/recovery/scope";
import type { RecoveryScope } from "@/lib/recovery/contracts";

class SchedulerRedis {
  leader: string | null = null;
  due = new Map<string, number>();
  hashes = new Map<string, Record<string, string>>();
  evalCalls: string[] = [];
  allowLeader = true;
  budgetAllowed = true;
  concurrencyAllowed = true;

  async time(): Promise<[string, string]> {
    return ["100", "500000"];
  }
  async set(_key: string, value: string): Promise<unknown> {
    if (!this.allowLeader) return null;
    this.leader = value;
    return "OK";
  }
  async get(): Promise<string | null> {
    return this.leader;
  }
  async pexpire(): Promise<number> {
    return 1;
  }
  async zadd(_key: string, score: number, member: string): Promise<number> {
    this.due.set(member, score);
    return 1;
  }
  async zrem(_key: string, ...members: string[]): Promise<number> {
    let removed = 0;
    for (const member of members) removed += Number(this.due.delete(member));
    return removed;
  }
  async zrangebyscore(): Promise<string[]> {
    return [...this.due.entries()]
      .filter(([, score]) => score <= 100_500)
      .map(([member]) => member);
  }
  async scan(): Promise<[string, string[]]> {
    return ["0", [...this.hashes.keys()]];
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.[field] ?? null;
  }
  async eval(script: string): Promise<unknown> {
    this.evalCalls.push(script);
    if (script.includes("rpm_key")) return this.budgetAllowed ? [1, "ok"] : [0, "rpm"];
    if (script.includes("provider_count")) return this.concurrencyAllowed ? 1 : 0;
    return 1;
  }
}

const provider = (providerId: number): RecoveryScope => ({ kind: "provider", providerId });

describe("recovery due scheduler", () => {
  it("parses every canonical scope and rejects malformed identities", () => {
    const scopes: RecoveryScope[] = [
      provider(1),
      { kind: "vendor-type", vendorId: 2, providerType: "claude" },
      {
        kind: "endpoint",
        providerId: 3,
        endpoint: { kind: "managed", endpointId: 4 },
      },
      {
        kind: "endpoint",
        providerId: 3,
        endpoint: { kind: "direct", endpointHash: "a".repeat(64) },
      },
      { kind: "capability", providerId: 5, modelFamily: "model", transport: "http" },
    ];
    for (const scope of scopes) {
      expect(parseCanonicalRecoveryScope(canonicalizeRecoveryScope(scope))).toEqual(scope);
    }
    expect(() => parseCanonicalRecoveryScope("{}")).toThrow("invalid canonical");
    expect(() => parseCanonicalRecoveryScope(JSON.stringify(["recovery-scope", 1, "bad"]))).toThrow(
      "unknown canonical"
    );
    expect(deterministicProbeBackoffMs(provider(1), 2)).toBe(
      deterministicProbeBackoffMs(provider(1), 2)
    );
    expect(deterministicProbeBackoffMs(provider(1), -1, 100, 100)).toBeLessThanOrEqual(100);
  });

  it("uses Redis time, budgets, claims, accounting, and deterministic completion", async () => {
    const redis = new SchedulerRedis();
    const state = new Map<number, any>([
      [1, { health: "closed", epoch: 1, nextProbeAt: null, probeAttemptCount: 0 }],
      [2, { health: "open", epoch: 1, nextProbeAt: 1, probeAttemptCount: 1 }],
      [3, { health: "open", epoch: 1, nextProbeAt: 1, probeAttemptCount: 2 }],
    ]);
    const completeProbe = vi.fn(async () => undefined);
    const service = {
      getState: async (scope: RecoveryScope) =>
        scope.kind === "vendor-type" ? null : state.get(scope.providerId),
      claimProbe: vi.fn(async ({ scope }: { scope: RecoveryScope }) =>
        scope.kind !== "vendor-type" && scope.providerId === 2
          ? { code: "stale_epoch" }
          : { token: "token", epoch: 1, scope }
      ),
      completeProbe,
    };
    const execute = vi.fn(async () => ({
      succeeded: true,
      costUsd: 0.2,
      inputTokens: 2,
      outputTokens: 3,
    }));
    const accounting = vi.fn(async () => undefined);
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe", timeoutMs: 50 },
      execute,
      { accounting, reservedCostUsd: 0.4 }
    );
    for (const id of [1, 2, 3]) await scheduler.schedule(provider(id), 100_000);
    expect(await scheduler.tick()).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(completeProbe).toHaveBeenCalledOnce();
    expect(accounting).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.2 }));
    expect(redis.due.size).toBe(1);
    expect(redis.due.has(canonicalizeRecoveryScope(provider(2)))).toBe(true);
    expect(redis.evalCalls.some((script) => script.includes("INCRBYFLOAT"))).toBe(true);
  });

  it("fails closed on missing model, leadership, budget, concurrency, and executor errors", async () => {
    const redis = new SchedulerRedis();
    const service = {
      getState: async () => ({ health: "open", epoch: 1, nextProbeAt: 1, probeAttemptCount: 0 }),
      claimProbe: async ({ scope }: { scope: RecoveryScope }) => ({ token: "t", epoch: 1, scope }),
      completeProbe: vi.fn(),
    };
    const disabled = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: null },
      vi.fn()
    );
    expect(await disabled.tick()).toBe(0);

    const accounting = vi.fn(async () => undefined);
    const scheduler = new RecoveryDueScheduler(
      redis,
      service,
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe" },
      vi.fn(async () => {
        throw new Error("worker died");
      }),
      { accounting, reservedCostUsd: 0 }
    );
    await scheduler.schedule(provider(4), 1);
    redis.allowLeader = false;
    redis.leader = "other";
    expect(await scheduler.tick()).toBe(0);
    redis.allowLeader = true;
    redis.budgetAllowed = false;
    expect(await scheduler.tick()).toBe(0);
    redis.budgetAllowed = true;
    redis.concurrencyAllowed = false;
    expect(await scheduler.tick()).toBe(0);
    redis.concurrencyAllowed = true;
    await expect(scheduler.tick()).rejects.toThrow("worker died");
    expect(accounting).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: null, succeeded: false })
    );
  });

  it("reconciles missing and stale due-index members from bounded state scans", async () => {
    const redis = new SchedulerRedis();
    const openScope = provider(8);
    const closedScope = provider(9);
    redis.hashes.set("cb:v2:{open}:state", {
      health: "open",
      next_probe_at: "123",
      scope_json: canonicalizeRecoveryScope(openScope),
    });
    redis.hashes.set("cb:v2:{closed}:state", {
      health: "closed",
      next_probe_at: "0",
      scope_json: canonicalizeRecoveryScope(closedScope),
    });
    redis.hashes.set("cb:v2:{missing}:state", { health: "open" });
    redis.due.set(canonicalizeRecoveryScope(closedScope), 1);
    const scheduler = new RecoveryDueScheduler(
      redis,
      { getState: vi.fn(), claimProbe: vi.fn(), completeProbe: vi.fn() },
      { ...CODE_PROBE_BUDGET_DEFAULTS, safeModel: "safe" },
      vi.fn()
    );
    expect(await scheduler.reconcile("0", 10)).toEqual({ cursor: "0", repaired: 1 });
    expect(redis.due.has(canonicalizeRecoveryScope(openScope))).toBe(true);
    expect(redis.due.has(canonicalizeRecoveryScope(closedScope))).toBe(false);
  });
});
