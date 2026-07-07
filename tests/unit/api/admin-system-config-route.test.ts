import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());
const getSystemSettingsMock = vi.hoisted(() => vi.fn());
const updateSystemSettingsMock = vi.hoisted(() => vi.fn());
const invalidateSystemSettingsCacheMock = vi.hoisted(() => vi.fn());
const invalidateProviderSelectorSystemSettingsCacheMock = vi.hoisted(() => vi.fn());
const invalidateAllOverviewCachesMock = vi.hoisted(() => vi.fn());
const invalidateAllStatisticsCachesMock = vi.hoisted(() => vi.fn());
const invalidateAllLeaderboardCachesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/config", () => ({
  invalidateSystemSettingsCache: invalidateSystemSettingsCacheMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return {
    ...actual,
    invalidateAllOverviewCaches: invalidateAllOverviewCachesMock,
    invalidateAllStatisticsCaches: invalidateAllStatisticsCachesMock,
    invalidateAllLeaderboardCaches: invalidateAllLeaderboardCachesMock,
  };
});

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: getSystemSettingsMock,
  updateSystemSettings: updateSystemSettingsMock,
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector-settings-cache", () => ({
  invalidateProviderSelectorSystemSettingsCache: invalidateProviderSelectorSystemSettingsCacheMock,
}));

describe("POST /api/admin/system-config", () => {
  let POST: typeof import("@/app/api/admin/system-config/route").POST;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 1, role: "admin" } });
    getSystemSettingsMock.mockResolvedValue({ timezone: "UTC" });
    updateSystemSettingsMock.mockImplementation(async (input) => input);

    ({ POST } = await import("@/app/api/admin/system-config/route"));
  });

  it("forwards the newer system settings fields to updateSystemSettings", async () => {
    const response = await POST(
      new Request("http://localhost/api/admin/system-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          billNonSuccessfulRequests: true,
          billHedgeLosers: false,
          enableThinkingEffortConflictRectifier: false,
          allowNonConversationEndpointProviderFallback: true,
          publicStatusWindowHours: 72,
          publicStatusAggregationIntervalMinutes: 15,
          ipGeoLookupEnabled: false,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(updateSystemSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        billNonSuccessfulRequests: true,
        billHedgeLosers: false,
        enableThinkingEffortConflictRectifier: false,
        allowNonConversationEndpointProviderFallback: true,
        publicStatusWindowHours: 72,
        publicStatusAggregationIntervalMinutes: 15,
        ipGeoLookupEnabled: false,
      })
    );
  });

  it("does not invalidate timezone-sensitive caches when timezone is unchanged", async () => {
    const response = await POST(
      new Request("http://localhost/api/admin/system-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timezone: "UTC",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(invalidateSystemSettingsCacheMock).toHaveBeenCalledTimes(1);
    expect(invalidateProviderSelectorSystemSettingsCacheMock).toHaveBeenCalledTimes(1);
    expect(invalidateAllOverviewCachesMock).not.toHaveBeenCalled();
    expect(invalidateAllStatisticsCachesMock).not.toHaveBeenCalled();
    expect(invalidateAllLeaderboardCachesMock).not.toHaveBeenCalled();
  });
});
