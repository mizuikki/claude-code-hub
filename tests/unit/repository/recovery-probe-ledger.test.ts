import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>> }));

vi.mock("@/drizzle/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        mocks.inserted.push(value);
      }),
    })),
  },
}));

describe("recovery probe ledger", () => {
  beforeEach(() => {
    mocks.inserted = [];
  });

  test("records unknown cost explicitly without user, key, team, or session attribution", async () => {
    const { recordRecoveryProbeUsage } = await import("@/repository/recovery-probe-ledger");
    await expect(
      recordRecoveryProbeUsage({
        scope: { kind: "provider", providerId: 7 },
        model: "safe-model",
        inputTokens: 3,
        outputTokens: 2,
        costUsd: null,
        succeeded: false,
        durationMs: 19,
      })
    ).resolves.toBe(true);

    expect(mocks.inserted[0]).toMatchObject({
      providerId: 7,
      costUsd: null,
      costUnknown: true,
      inputTokens: 3,
      outputTokens: 2,
    });
    for (const forbidden of ["userId", "keyId", "teamId", "sessionId", "requestId"]) {
      expect(mocks.inserted[0]).not.toHaveProperty(forbidden);
    }
  });

  test("does not attribute vendor-wide probes to an arbitrary provider", async () => {
    const { recordRecoveryProbeUsage } = await import("@/repository/recovery-probe-ledger");
    await expect(
      recordRecoveryProbeUsage({
        scope: { kind: "vendor-type", vendorId: 2, providerType: "claude" },
        model: "safe-model",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        succeeded: true,
        durationMs: 1,
      })
    ).resolves.toBe(false);
    expect(mocks.inserted).toHaveLength(0);
  });
});
