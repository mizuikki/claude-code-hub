import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPersisted: vi.fn(),
}));

vi.mock("@/repository/recovery-config", () => ({
  getPersistedRecoveryConfiguration: mocks.getPersisted,
}));

vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  return {
    ...actual,
    getEnvConfig: () => actual.EnvSchema.parse({ NODE_ENV: "test" }),
  };
});

describe("recovery configuration cache", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getPersisted.mockReset();
    mocks.getPersisted.mockResolvedValue({
      system: {
        recoveryAuthorityMode: null,
        sessionBindingAuthorityMode: null,
        recoverySettings: null,
        recoveryProbeBudgets: null,
        sessionFailbackSettings: null,
      },
      provider: null,
    });
  });

  test("deduplicates live entries and supports provider and global invalidation", async () => {
    const { getCachedRecoveryConfiguration, invalidateRecoveryConfiguration } = await import(
      "@/lib/recovery/config-cache"
    );
    const [first, second] = await Promise.all([
      getCachedRecoveryConfiguration(7),
      getCachedRecoveryConfiguration(7),
    ]);
    expect(first.recovery.windowDurationMs.effective).toBe(60_000);
    expect(second).toBe(first);
    expect(mocks.getPersisted).toHaveBeenCalledTimes(1);

    invalidateRecoveryConfiguration(7);
    await getCachedRecoveryConfiguration(7);
    expect(mocks.getPersisted).toHaveBeenCalledTimes(2);

    await getCachedRecoveryConfiguration();
    invalidateRecoveryConfiguration();
    await getCachedRecoveryConfiguration();
    expect(mocks.getPersisted).toHaveBeenCalledTimes(4);
  });

  test("does not cache repository failures", async () => {
    mocks.getPersisted.mockRejectedValueOnce(new Error("database unavailable"));
    const { getCachedRecoveryConfiguration } = await import("@/lib/recovery/config-cache");
    await expect(getCachedRecoveryConfiguration(9)).rejects.toThrow("database unavailable");
    await expect(getCachedRecoveryConfiguration(9)).resolves.toBeDefined();
    expect(mocks.getPersisted).toHaveBeenCalledTimes(2);
  });
});
