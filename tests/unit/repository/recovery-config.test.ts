import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  returningRows: [] as unknown[],
  setValues: [] as unknown[],
}));

function chainReturning() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn((value: unknown) => {
    mocks.setValues.push(value);
    return chain;
  });
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => mocks.returningRows);
  chain.values = vi.fn((value: unknown) => {
    mocks.setValues.push(value);
    return chain;
  });
  chain.onConflictDoUpdate = vi.fn((value: unknown) => {
    mocks.setValues.push(value);
    return chain;
  });
  return chain;
}

vi.mock("@/drizzle/db", () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(async () => mocks.selectRows);
      return chain;
    }),
    update: vi.fn(() => chainReturning()),
    insert: vi.fn(() => chainReturning()),
  },
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(async () => ({ id: 1 })),
}));

describe("recovery config repository", () => {
  beforeEach(() => {
    mocks.selectRows = [];
    mocks.returningRows = [];
    mocks.setValues = [];
  });

  test("preserves nullable system overrides and clearing", async () => {
    mocks.returningRows = [
      {
        recoveryAuthorityMode: null,
        sessionBindingAuthorityMode: "legacy",
        recoverySettings: null,
        recoveryProbeBudgets: { maxTokensPerProbe: 16 },
        sessionFailbackSettings: null,
      },
    ];
    const { updateSystemRecoveryConfiguration } = await import("@/repository/recovery-config");
    const result = await updateSystemRecoveryConfiguration({
      recoveryAuthorityMode: null,
      recoverySettings: null,
      sessionFailbackSettings: null,
    });
    expect(result.recoverySettings).toBeNull();
    expect(mocks.setValues[0]).toMatchObject({
      recoveryAuthorityMode: null,
      recoverySettings: null,
      sessionFailbackSettings: null,
    });
  });

  test("validates provider overrides and permits explicit inheritance clearing", async () => {
    mocks.returningRows = [{ providerId: 7, recoverySettings: null, recoveryProbeBudgets: null }];
    const { updateProviderRecoveryConfiguration } = await import("@/repository/recovery-config");
    await expect(
      updateProviderRecoveryConfiguration(7, {
        recoverySettings: { maximumFailureRate: 2 },
        recoveryProbeBudgets: null,
      })
    ).rejects.toThrow();
    await expect(
      updateProviderRecoveryConfiguration(7, {
        recoverySettings: null,
        recoveryProbeBudgets: null,
      })
    ).resolves.toMatchObject({ providerId: 7, recoverySettings: null });
  });

  test("stores nullable API-key failback override", async () => {
    mocks.returningRows = [{ id: 9 }];
    const { setKeyFailbackModeOverride } = await import("@/repository/recovery-config");
    await expect(setKeyFailbackModeOverride(9, null)).resolves.toBe(true);
    expect(mocks.setValues[0]).toMatchObject({ sessionFailbackModeOverride: null });
  });

  test("upserts compact degraded OPEN evidence and rejects unsafe classifications", async () => {
    const observedAt = new Date("2026-08-01T00:00:00.000Z");
    mocks.returningRows = [
      {
        scopeHash: "9886b341c70978181c1994ea4d39a7425c4bbb3e2ac5de22a62ad5bb859b3a4c",
        scope: { kind: "provider", providerId: 12 },
        observedAt,
        failureClass: "network_error",
        sourceInstanceId: "instance-build-hash",
        evidenceCount: 2,
        reconciledAt: null,
      },
    ];
    const { upsertDegradedOpenEvidence } = await import("@/repository/recovery-config");
    await expect(
      upsertDegradedOpenEvidence({
        scope: { kind: "provider", providerId: 12 },
        observedAt,
        failureClass: "network_error",
        sourceInstanceId: "instance-build-hash",
      })
    ).resolves.toMatchObject({ evidenceCount: 2, reconciledAt: null });
    expect(mocks.setValues[0]).toMatchObject({
      scopeHash: "9886b341c70978181c1994ea4d39a7425c4bbb3e2ac5de22a62ad5bb859b3a4c",
      failureClass: "network_error",
    });
    await expect(
      upsertDegradedOpenEvidence({
        scope: { kind: "provider", providerId: 12 },
        observedAt,
        failureClass: "raw failure with request content",
        sourceInstanceId: "instance",
      })
    ).rejects.toThrow(TypeError);
  });

  test("deduplicates and idempotently marks pending evidence reconciled", async () => {
    mocks.returningRows = [{ scopeHash: "a".repeat(64) }];
    const { markDegradedOpenEvidenceReconciled } = await import("@/repository/recovery-config");
    await expect(
      markDegradedOpenEvidenceReconciled(["a".repeat(64), "a".repeat(64), "invalid"])
    ).resolves.toBe(1);
    mocks.returningRows = [];
    await expect(markDegradedOpenEvidenceReconciled(["a".repeat(64)])).resolves.toBe(0);
  });
});
