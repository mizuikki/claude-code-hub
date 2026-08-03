import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildConfigurationTransferSnapshot,
  type ConfigurationCounts,
  type ConfigurationTransferTarget,
  runConfigurationTransfer,
  summarizeConfigurationTransfer,
} from "../../scripts/config-transfer";
import { extractCreatedUserId, ManagementApiTarget } from "../../scripts/transfer-config";

const PROVIDER_SECRET = "provider-secret-value-never-log";
const DISABLED_PROVIDER_SECRET = "disabled-provider-secret-never-log";
const USER_KEY_SECRET = "user-key-secret-value-never-log";

function sourceRows() {
  return {
    providerGroups: [{ id: 1, name: "default", cost_multiplier: "1.0", description: "Default" }],
    providerVendors: [
      {
        id: 10,
        website_domain: "example.com",
        display_name: "Example",
        website_url: "https://example.com",
      },
      { id: 11, website_domain: "unused.example" },
    ],
    providers: [
      {
        id: 100,
        name: "enabled",
        url: "https://api.example.com/v1",
        key: PROVIDER_SECRET,
        provider_vendor_id: 10,
        provider_type: "codex",
        is_enabled: true,
        cache_ttl_preference: null,
        allowed_clients: null,
        blocked_clients: null,
        codex_compaction_v2_capability: "native_v2",
      },
      {
        id: 101,
        name: "disabled",
        url: "https://backup.example.com/v1",
        key: DISABLED_PROVIDER_SECRET,
        provider_vendor_id: 10,
        provider_type: "codex",
        is_enabled: false,
      },
      {
        id: 102,
        name: "deleted",
        url: "https://deleted.example.com/v1",
        key: "deleted-provider-secret",
        provider_vendor_id: 10,
        provider_type: "codex",
        deleted_at: new Date(),
      },
    ],
    providerEndpoints: [
      {
        id: 110,
        vendor_id: 10,
        provider_type: "codex",
        url: "https://api.example.com/v1",
        label: "primary",
        sort_order: 2,
        is_enabled: false,
      },
      {
        id: 111,
        vendor_id: 10,
        provider_type: "codex",
        url: "https://deleted.example.com/v1",
        deleted_at: new Date(),
      },
    ],
    users: [
      {
        id: 200,
        name: "operator",
        role: "user",
        provider_group: "default",
        is_enabled: false,
        tags: ["ops"],
        allowed_clients: null,
        blocked_clients: null,
        allowed_models: null,
      },
      { id: 201, name: "deleted", role: "user", deleted_at: new Date() },
    ],
    keys: [
      {
        id: 300,
        user_id: 200,
        name: "automation",
        key: USER_KEY_SECRET,
        is_enabled: true,
        provider_group: "default",
        cache_ttl_preference: null,
      },
      { id: 301, user_id: 201, name: "deleted-user-key", key: "deleted-user-secret" },
      {
        id: 302,
        user_id: 200,
        name: "deleted-key",
        key: "deleted-key-secret",
        deleted_at: new Date(),
      },
    ],
  };
}

const EMPTY_COUNTS: ConfigurationCounts = {
  providerGroups: 0,
  providers: 0,
  providerVendors: 0,
  providerEndpoints: 0,
  users: 0,
  keys: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

class Target implements ConfigurationTransferTarget {
  operations: string[] = [];
  providerPayloads: Array<Record<string, unknown>> = [];
  endpointPayloads: Array<{ vendorId: number; payload: Record<string, unknown> }> = [];
  userPayloads: Array<Record<string, unknown>> = [];
  keyPayloads: Array<{ userId: number; payload: Record<string, unknown> }> = [];
  counts = EMPTY_COUNTS;
  failAt: string | null = null;

  async countConfiguration() {
    this.operations.push("preflight");
    return this.counts;
  }

  async createProviderGroup() {
    this.operations.push("group");
    return { id: 501 };
  }

  async createProvider(payload: Record<string, unknown>) {
    this.operations.push("provider");
    if (this.failAt === "provider") throw new Error(`unsafe ${PROVIDER_SECRET}`);
    this.providerPayloads.push(payload);
    return { id: 600 + this.providerPayloads.length, providerVendorId: 700 };
  }

  async revealProviderKey(providerId: number) {
    this.operations.push("provider-reveal");
    return providerId === 601 ? PROVIDER_SECRET : DISABLED_PROVIDER_SECRET;
  }

  async updateProviderVendor() {
    this.operations.push("vendor");
  }

  async upsertProviderEndpoint(vendorId: number, payload: Record<string, unknown>) {
    this.operations.push("endpoint");
    this.endpointPayloads.push({ vendorId, payload });
  }

  async createUser(payload: Record<string, unknown>) {
    this.operations.push("user");
    this.userPayloads.push(payload);
    return { id: 800 };
  }

  async createUserKey(userId: number, payload: Record<string, unknown>) {
    this.operations.push("key");
    this.keyPayloads.push({ userId, payload });
    return { id: 900 };
  }

  async revealUserKey() {
    this.operations.push("key-reveal");
    return USER_KEY_SECRET;
  }
}

describe("configuration transfer", () => {
  test("filters soft-deleted configuration while retaining disabled providers", () => {
    const snapshot = buildConfigurationTransferSnapshot(sourceRows());
    expect(snapshot.providers.map((provider) => provider.id)).toEqual([100, 101]);
    expect(snapshot.providers[1].is_enabled).toBe(false);
    expect(snapshot.providerEndpoints.map((endpoint) => endpoint.id)).toEqual([110]);
    expect(snapshot.users.map((user) => user.id)).toEqual([200]);
    expect(snapshot.keys.map((key) => key.id)).toEqual([300]);
    expect(snapshot.providerVendors.map((vendor) => vendor.id)).toEqual([10]);
  });

  test("dry-run performs preflight only and reports secret-safe counts and fingerprints", async () => {
    const target = new Target();
    const report = await runConfigurationTransfer({
      snapshot: buildConfigurationTransferSnapshot(sourceRows()),
      target,
      dryRun: true,
      fingerprintKey: "fingerprint-key-for-tests",
    });
    expect(target.operations).toEqual(["preflight"]);
    expect(report.counts).toEqual({
      providerGroups: 1,
      providers: 2,
      providerVendors: 1,
      providerEndpoints: 1,
      users: 1,
      keys: 1,
    });
    expect(report.fingerprints.providerKeys).toMatch(/^[a-f0-9]{20}$/);
    const output = JSON.stringify(report);
    expect(output).not.toContain(PROVIDER_SECRET);
    expect(output).not.toContain(DISABLED_PROVIDER_SECRET);
    expect(output).not.toContain(USER_KEY_SECRET);
  });

  test("produces comparable fingerprints for the same approved snapshot", () => {
    const snapshot = buildConfigurationTransferSnapshot(sourceRows());
    const first = summarizeConfigurationTransfer(snapshot, "fingerprint-key-for-tests", "dry-run");
    const second = summarizeConfigurationTransfer(snapshot, "fingerprint-key-for-tests", "dry-run");
    expect(second.counts).toEqual(first.counts);
    expect(second.fingerprints).toEqual(first.fingerprints);

    const changed = buildConfigurationTransferSnapshot(sourceRows());
    changed.keys[0].key = "another-user-key-value";
    expect(
      summarizeConfigurationTransfer(changed, "fingerprint-key-for-tests", "dry-run").fingerprints
    ).not.toEqual(first.fingerprints);
  });

  test("imports in dependency order, maps identifiers, and verifies exact secrets", async () => {
    const target = new Target();
    await runConfigurationTransfer({
      snapshot: buildConfigurationTransferSnapshot(sourceRows()),
      target,
      dryRun: false,
      fingerprintKey: "fingerprint-key-for-tests",
    });
    expect(target.operations).toEqual([
      "preflight",
      "group",
      "provider",
      "provider-reveal",
      "provider",
      "provider-reveal",
      "vendor",
      "endpoint",
      "user",
      "key",
      "key-reveal",
    ]);
    expect(target.providerPayloads[0]).toMatchObject({
      codex_compaction_v2_capability: "native_v2",
      key: PROVIDER_SECRET,
      allowed_clients: [],
      blocked_clients: [],
    });
    expect(target.providerPayloads[0]).not.toHaveProperty("cache_ttl_preference");
    expect(target.providerPayloads[1]).toMatchObject({
      codex_compaction_v2_capability: "legacy_adapter",
      is_enabled: false,
    });
    expect(target.endpointPayloads[0]).toMatchObject({ vendorId: 700 });
    expect(target.userPayloads[0]).toMatchObject({
      name: "operator",
      isEnabled: false,
      allowedClients: [],
      blockedClients: [],
      allowedModels: [],
    });
    expect(target.keyPayloads[0]).toEqual({
      userId: 800,
      payload: expect.objectContaining({ key: USER_KEY_SECRET, name: "automation" }),
    });
    expect(target.keyPayloads[0].payload).not.toHaveProperty("cacheTtlPreference");
  });

  test("refuses a non-empty target before any mutation", async () => {
    const target = new Target();
    target.counts = { ...EMPTY_COUNTS, providers: 1 };
    await expect(
      runConfigurationTransfer({
        snapshot: buildConfigurationTransferSnapshot(sourceRows()),
        target,
        dryRun: false,
        fingerprintKey: "fingerprint-key-for-tests",
      })
    ).rejects.toThrow("Target contains provider or user configuration");
    expect(target.operations).toEqual(["preflight"]);
  });

  test("refuses a target containing existing users or keys", async () => {
    const target = new Target();
    target.counts = { ...EMPTY_COUNTS, users: 1, keys: 2 };
    await expect(
      runConfigurationTransfer({
        snapshot: buildConfigurationTransferSnapshot(sourceRows()),
        target,
        dryRun: false,
        fingerprintKey: "fingerprint-key-for-tests",
      })
    ).rejects.toThrow("Target contains provider or user configuration");
    expect(target.operations).toEqual(["preflight"]);
  });

  test("fails closed with a sanitized recreate-and-rerun instruction", async () => {
    const target = new Target();
    target.failAt = "provider";
    let message = "";
    try {
      await runConfigurationTransfer({
        snapshot: buildConfigurationTransferSnapshot(sourceRows()),
        target,
        dryRun: false,
        fingerprintKey: "fingerprint-key-for-tests",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("recreate the isolated target and rerun");
    expect(message).not.toContain(PROVIDER_SECRET);
  });

  test("can rerun successfully after the partial target is recreated", async () => {
    const target = new Target();
    target.failAt = "provider";
    const snapshot = buildConfigurationTransferSnapshot(sourceRows());
    const options = {
      snapshot,
      target,
      dryRun: false,
      fingerprintKey: "fingerprint-key-for-tests",
    };

    await expect(runConfigurationTransfer(options)).rejects.toThrow(
      "recreate the isolated target and rerun"
    );
    target.failAt = null;
    target.operations = [];
    await expect(runConfigurationTransfer(options)).resolves.toMatchObject({ mode: "import" });
    expect(target.operations[0]).toBe("preflight");
  });

  test("rejects invalid source relationships and fingerprint configuration", () => {
    const missingVendorRows = sourceRows();
    missingVendorRows.providerVendors = [];
    expect(() => buildConfigurationTransferSnapshot(missingVendorRows)).toThrow(
      "missing provider vendor"
    );

    const snapshot = buildConfigurationTransferSnapshot(sourceRows());
    expect(() => summarizeConfigurationTransfer(snapshot, "too-short", "dry-run")).toThrow(
      "at least 16 characters"
    );
  });

  test.each([
    [
      "unsupported provider type",
      (rows: ReturnType<typeof sourceRows>) => {
        rows.providers[0].provider_type = "removed_provider_type";
      },
      (_target: Target) => undefined,
      "providers",
    ],
    [
      "invalid provider number",
      (rows: ReturnType<typeof sourceRows>) => {
        Object.assign(rows.providers[0], { cost_multiplier: "not-a-number" });
      },
      (_target: Target) => undefined,
      "providers",
    ],
    [
      "provider secret mismatch",
      (_rows: ReturnType<typeof sourceRows>) => undefined,
      (target: Target) => {
        target.revealProviderKey = async () => "different-secret";
      },
      "providers",
    ],
    [
      "missing target vendor",
      (_rows: ReturnType<typeof sourceRows>) => undefined,
      (target: Target) => {
        target.createProvider = async () => ({ id: 601, providerVendorId: null });
      },
      "providers",
    ],
    [
      "conflicting target vendor mapping",
      (_rows: ReturnType<typeof sourceRows>) => undefined,
      (target: Target) => {
        let provider = 0;
        target.createProvider = async () => ({
          id: 601 + provider,
          providerVendorId: 700 + provider++,
        });
      },
      "providers",
    ],
    [
      "unmapped endpoint vendor",
      (rows: ReturnType<typeof sourceRows>) => {
        rows.providerEndpoints.push({
          id: 112,
          vendor_id: 11,
          provider_type: "codex",
          url: "https://unused.example/v1",
          label: "unused",
          sort_order: 3,
          is_enabled: true,
        });
      },
      (_target: Target) => undefined,
      "provider vendors and endpoints",
    ],
    [
      "unsupported user role",
      (rows: ReturnType<typeof sourceRows>) => {
        rows.users[0].role = "admin";
      },
      (_target: Target) => undefined,
      "users and keys",
    ],
    [
      "invalid key timestamp",
      (rows: ReturnType<typeof sourceRows>) => {
        Object.assign(rows.keys[0], { expires_at: "not-a-date" });
      },
      (_target: Target) => undefined,
      "users and keys",
    ],
  ])("sanitizes %s failures", async (_name, mutateRows, mutateTarget, stage) => {
    const rows = sourceRows();
    mutateRows(rows);
    const target = new Target();
    mutateTarget(target);

    await expect(
      runConfigurationTransfer({
        snapshot: buildConfigurationTransferSnapshot(rows),
        target,
        dryRun: false,
        fingerprintKey: "fingerprint-key-for-tests",
      })
    ).rejects.toThrow(`Configuration transfer failed during ${stage}`);
  });

  test("counts every paginated user and redacted key before import", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      const response = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      if (url.pathname.endsWith("/provider-groups")) {
        return response({ items: [{ id: 1 }] });
      }
      if (url.pathname.endsWith("/providers")) {
        return response({ items: [{ id: 10 }] });
      }
      if (url.pathname.endsWith("/provider-vendors")) {
        return response({ items: [{ id: 20 }] });
      }
      if (url.pathname.endsWith("/provider-vendors/20/endpoints")) {
        return response({ items: [{ id: 30 }, { id: 31 }] });
      }
      if (url.pathname.endsWith("/users")) {
        if (url.searchParams.get("cursor") === "cursor-2") {
          return response({
            items: [{ id: 3, keys: [{}] }],
            pageInfo: { hasMore: false, nextCursor: null, limit: 100 },
          });
        }
        return response({
          items: [
            { id: 1, keys: [{ id: 101 }, { id: 102 }] },
            { id: 2, keys: [] },
          ],
          pageInfo: { hasMore: true, nextCursor: "cursor-2", limit: 100 },
        });
      }
      throw new Error(`Unexpected target URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const counts = await new ManagementApiTarget(
      "https://target.example/api/v1",
      "admin-token"
    ).countConfiguration();

    expect(counts).toEqual({
      providerGroups: 1,
      providers: 1,
      providerVendors: 1,
      providerEndpoints: 2,
      users: 3,
      keys: 3,
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("cursor=cursor-2"))).toBe(
      true
    );
  });

  test("reads the wrapped user response returned by the management API", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ user: { id: 901, name: "operator" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const target = new ManagementApiTarget("https://target.example/api/v1", "admin-token");
    await expect(target.createUser({ name: "operator" })).resolves.toEqual({ id: 901 });
    expect(extractCreatedUserId({ user: { id: 901 } })).toBe(901);
    expect(() => extractCreatedUserId({ id: 901 })).toThrow("Target omitted user");
  });
});
