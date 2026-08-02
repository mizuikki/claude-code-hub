import type { AuthSession } from "@/lib/auth";
import { beforeEach, describe, expect, test, vi } from "vitest";

const validateAuthTokenMock = vi.hoisted(() => vi.fn());
const getPersistedMock = vi.hoisted(() => vi.fn());
const updateConfigurationMock = vi.hoisted(() => vi.fn());
const updateProviderConfigurationMock = vi.hoisted(() => vi.fn());
const getCachedConfigurationMock = vi.hoisted(() => vi.fn());
const invalidateConfigurationMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());
const administrateMock = vi.hoisted(() => vi.fn());
const runProbeMock = vi.hoisted(() => vi.fn());
const initializeRuntimeMock = vi.hoisted(() => vi.fn());
const emitAuditMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, validateAuthToken: validateAuthTokenMock };
});

vi.mock("@/repository/recovery-config", () => ({
  getPersistedRecoveryConfiguration: getPersistedMock,
  updateSystemRecoveryConfiguration: updateConfigurationMock,
  updateProviderRecoveryConfiguration: updateProviderConfigurationMock,
}));

vi.mock("@/lib/recovery/config-cache", () => ({
  getCachedRecoveryConfiguration: getCachedConfigurationMock,
  invalidateRecoveryConfiguration: invalidateConfigurationMock,
}));

vi.mock("@/lib/recovery/runtime", () => ({
  getRecoveryManagementService: () => ({ getState: getStateMock, administrate: administrateMock }),
  initializeRecoveryRuntime: initializeRuntimeMock,
  recoveryRuntimeIsDegraded: () => false,
  runRecoveryProbe: runProbeMock,
}));

vi.mock("@/lib/audit/emit", () => ({ emitActionAudit: emitAuditMock }));

const { callV1Route } = await import("../test-utils");

const adminSession = {
  user: { id: 1, role: "admin", isEnabled: true },
  key: { id: 1, userId: 1, key: "admin-token", canLoginWebUi: true },
} as AuthSession;

const headers = { Authorization: "Bearer admin-token" };
const configuration = {
  recovery: { enabled: { configured: null, effective: true, source: "code" } },
  probeBudgets: {},
  failback: {},
};

describe("v1 recovery operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateAuthTokenMock.mockResolvedValue(adminSession);
    getPersistedMock.mockResolvedValue({
      system: { recoveryAuthorityMode: "enforce", sessionBindingAuthorityMode: "v2_only" },
      provider: null,
    });
    getCachedConfigurationMock.mockResolvedValue(configuration);
    getStateMock.mockResolvedValue({ health: "open", epoch: 7, automationPaused: false });
    administrateMock.mockResolvedValue({ code: "applied", epoch: 8, health: "open" });
    runProbeMock.mockResolvedValue({ code: "applied", epoch: 8, health: "half_open" });
    initializeRuntimeMock.mockResolvedValue("enforce");
    updateConfigurationMock.mockResolvedValue({
      recoveryAuthorityMode: "enforce",
      sessionBindingAuthorityMode: "v2_only",
      recoverySettings: null,
      recoveryProbeBudgets: null,
      sessionFailbackSettings: null,
    });
    updateProviderConfigurationMock.mockResolvedValue({
      providerId: 4,
      recoverySettings: { minimumRealOutcomes: 8 },
      recoveryProbeBudgets: null,
    });
  });

  test("returns provider diagnostics without credential or URL material", async () => {
    const result = await callV1Route({
      method: "GET",
      pathname: "/api/v1/recovery/providers/4",
      headers,
    });

    expect(result.response.status).toBe(200);
    expect(result.json).toMatchObject({
      scope: { kind: "provider", providerId: 4 },
      state: { health: "open", epoch: 7 },
      authority: { recovery: "enforce", binding: "v2_only" },
      degraded: false,
    });
    expect(JSON.stringify(result.json)).not.toContain("admin-token");
  });

  test.each([
    [
      "/api/v1/recovery/providers/4/endpoints/9",
      { kind: "endpoint", providerId: 4, endpoint: { kind: "managed", endpointId: 9 } },
    ],
    [
      "/api/v1/recovery/vendors/3/types/claude",
      { kind: "vendor-type", vendorId: 3, providerType: "claude" },
    ],
    [
      "/api/v1/recovery/providers/4/capabilities/model/http",
      { kind: "capability", providerId: 4, modelFamily: "model", transport: "http" },
    ],
  ])("returns redacted diagnostics for %s", async (pathname, expectedScope) => {
    const result = await callV1Route({ method: "GET", pathname, headers });
    expect(result.response.status).toBe(200);
    expect(result.json).toMatchObject({ scope: expectedScope, degraded: false });
    expect(JSON.stringify(result.json)).not.toContain("admin-token");
  });

  test.each([
    "/api/v1/recovery/providers/4/endpoints/9/actions/pause",
    "/api/v1/recovery/vendors/3/types/claude/actions/resume",
    "/api/v1/recovery/providers/4/capabilities/model/http/actions/force-open",
  ])("operates and audits every scoped recovery surface at %s", async (pathname) => {
    const result = await callV1Route({
      method: "POST",
      pathname,
      headers,
      body: { expectedEpoch: 7, reason: "operator verification" },
    });
    expect(result.response.status).toBe(200);
    expect(emitAuditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetType: "recovery_scope",
        before: { expectedEpoch: 7, reason: "operator verification" },
        success: true,
      })
    );
  });

  test("maps stale epochs and force-close confirmation to conflicts with audited reasons", async () => {
    administrateMock
      .mockResolvedValueOnce({ code: "stale_epoch", epoch: 9, health: "open" })
      .mockResolvedValueOnce({ code: "confirmation_required", epoch: 9, health: "open" });

    const stale = await callV1Route({
      method: "POST",
      pathname: "/api/v1/recovery/providers/4/actions/pause",
      headers,
      body: { expectedEpoch: 7, reason: "maintenance" },
    });
    const unconfirmed = await callV1Route({
      method: "POST",
      pathname: "/api/v1/recovery/providers/4/actions/force-close",
      headers,
      body: { expectedEpoch: 9, reason: "operator validation" },
    });

    expect(stale.response.status).toBe(409);
    expect(stale.json).toMatchObject({ errorCode: "recovery.stale_epoch" });
    expect(unconfirmed.response.status).toBe(409);
    expect(unconfirmed.json).toMatchObject({ errorCode: "recovery.confirmation_required" });
    expect(emitAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "recovery_scope",
        before: expect.objectContaining({ reason: "maintenance" }),
        success: false,
      })
    );
    expect(emitAuditMock.mock.calls[0][0].targetId).toMatch(/^[a-f0-9]{64}$/);
  });

  test("keeps reset OPEN and requires explicit force-close confirmation", async () => {
    const reset = await callV1Route({
      method: "POST",
      pathname: "/api/v1/recovery/providers/4/actions/reset",
      headers,
      body: { expectedEpoch: 7, reason: "restart validation" },
    });
    const closed = await callV1Route({
      method: "POST",
      pathname: "/api/v1/recovery/providers/4/actions/force-close",
      headers,
      body: {
        expectedEpoch: 8,
        reason: "independent upstream verification",
        confirmation: "FORCE_CLOSE",
      },
    });

    expect(reset.response.status).toBe(200);
    expect(reset.json).toMatchObject({ code: "applied", health: "open" });
    expect(closed.response.status).toBe(200);
    expect(administrateMock.mock.calls[1][0]).toMatchObject({
      action: "force_close",
      confirmation: "FORCE_CLOSE",
    });
  });

  test("updates nullable authority settings and reloads runtime", async () => {
    const result = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/recovery/configuration",
      headers,
      body: { recoveryAuthorityMode: "enforce", sessionBindingAuthorityMode: "v2_only" },
    });

    expect(result.response.status).toBe(200);
    expect(updateConfigurationMock).toHaveBeenCalledWith({
      recoveryAuthorityMode: "enforce",
      sessionBindingAuthorityMode: "v2_only",
    });
    expect(invalidateConfigurationMock).toHaveBeenCalled();
    expect(initializeRuntimeMock).toHaveBeenCalled();
  });

  test("updates nullable provider-owned recovery overrides", async () => {
    const result = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/recovery/providers/4/configuration",
      headers,
      body: {
        recoverySettings: { minimumRealOutcomes: 8 },
        recoveryProbeBudgets: null,
      },
    });

    expect(result.response.status).toBe(200);
    expect(updateProviderConfigurationMock).toHaveBeenCalledWith(4, {
      recoverySettings: { minimumRealOutcomes: 8 },
      recoveryProbeBudgets: null,
    });
    expect(emitAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "provider", targetId: "4", success: true })
    );
  });

  test("requires fleet or maintenance proof for production authority transitions", async () => {
    getPersistedMock.mockResolvedValueOnce({
      system: { recoveryAuthorityMode: "shadow", sessionBindingAuthorityMode: "shadow" },
      provider: null,
    });
    const rejected = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/recovery/configuration",
      headers,
      body: { recoveryAuthorityMode: "enforce" },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.json).toMatchObject({ errorCode: "recovery.rollout_gate_required" });

    getPersistedMock.mockResolvedValueOnce({
      system: { recoveryAuthorityMode: "shadow", sessionBindingAuthorityMode: "shadow" },
      provider: null,
    });
    const accepted = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/recovery/configuration",
      headers,
      body: { recoveryAuthorityMode: "enforce", rolloutProof: "maintenance_window" },
    });
    expect(accepted.response.status).toBe(200);
    expect(updateConfigurationMock).toHaveBeenLastCalledWith({
      recoveryAuthorityMode: "enforce",
    });
  });

  test("rejects direct Binding V2 rollback that bypasses atomic dual-write", async () => {
    const rejected = await callV1Route({
      method: "PATCH",
      pathname: "/api/v1/recovery/configuration",
      headers,
      body: {
        sessionBindingAuthorityMode: "legacy",
        rolloutProof: "maintenance_window",
      },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.json).toMatchObject({
      errorCode: "recovery.binding_authority_transition_invalid",
    });
    expect(updateConfigurationMock).not.toHaveBeenCalled();
  });
});
