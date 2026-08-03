import postgres from "postgres";
import {
  buildConfigurationTransferSnapshot,
  type ConfigurationCounts,
  type ConfigurationSourceRows,
  type ConfigurationTransferTarget,
  runConfigurationTransfer,
} from "./config-transfer";

async function loadSourceRows(sourceDsn: string): Promise<ConfigurationSourceRows> {
  const sql = postgres(sourceDsn, {
    max: 1,
    onnotice: () => undefined,
    connection: { application_name: "cch_config_transfer_read_only" },
  });
  try {
    return await sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION READ ONLY`;
      const [providerGroups, providerVendors, providers, providerEndpoints, users, keys] =
        await Promise.all([
          transaction`SELECT * FROM provider_groups ORDER BY id`,
          transaction`SELECT * FROM provider_vendors ORDER BY id`,
          transaction`SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY id`,
          transaction`SELECT * FROM provider_endpoints WHERE deleted_at IS NULL ORDER BY id`,
          transaction`SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id`,
          transaction`SELECT * FROM keys WHERE deleted_at IS NULL ORDER BY id`,
        ]);
      return {
        providerGroups: [...providerGroups],
        providerVendors: [...providerVendors],
        providers: [...providers],
        providerEndpoints: [...providerEndpoints],
        users: [...users],
        keys: [...keys],
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function items(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return [];
  const result = (value as { items?: unknown }).items;
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

function pageInfo(value: unknown): { hasMore: boolean; nextCursor?: string } {
  if (typeof value !== "object" || value === null) {
    throw new Error("Target returned an invalid page response");
  }
  const info = (value as { pageInfo?: unknown }).pageInfo;
  if (typeof info !== "object" || info === null) {
    throw new Error("Target returned an invalid page cursor");
  }
  const { hasMore, nextCursor } = info as {
    hasMore?: unknown;
    nextCursor?: unknown;
  };
  if (typeof hasMore !== "boolean") {
    throw new Error("Target returned an invalid page cursor");
  }
  if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
    throw new Error("Target returned an invalid page cursor");
  }
  return { hasMore, nextCursor: nextCursor || undefined };
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Target omitted ${label}`);
  return id;
}

export function extractCreatedUserId(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    throw new Error("Target omitted user");
  }
  const user = (value as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) {
    throw new Error("Target omitted user");
  }
  return positiveId((user as { id?: unknown }).id, "user id");
}

export class ManagementApiTarget implements ConfigurationTransferTarget {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Target API request failed: ${init.method ?? "GET"} ${path} (${response.status})`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async countConfiguration(): Promise<ConfigurationCounts> {
    const [groupsResponse, providersResponse, vendorsResponse] = await Promise.all([
      this.request("/provider-groups"),
      this.request("/providers"),
      this.request("/provider-vendors"),
    ]);
    const vendors = items(vendorsResponse);
    const endpointResponses = await Promise.all(
      vendors.map((vendor) =>
        this.request(`/provider-vendors/${positiveId(vendor.id, "vendor id")}/endpoints`)
      )
    );
    const userCounts = await this.countUsersAndKeys();
    return {
      providerGroups: items(groupsResponse).length,
      providers: items(providersResponse).length,
      providerVendors: vendors.length,
      providerEndpoints: endpointResponses.reduce((sum, value) => sum + items(value).length, 0),
      users: userCounts.users,
      keys: userCounts.keys,
    };
  }

  private async countUsersAndKeys(): Promise<{ users: number; keys: number }> {
    let cursor: string | undefined;
    let users = 0;
    let keys = 0;

    for (;;) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request(`/users?${query.toString()}`);
      const currentUsers = items(response);
      users += currentUsers.length;
      keys += currentUsers.reduce((total, user) => {
        const userKeys = user.keys;
        return total + (Array.isArray(userKeys) ? userKeys.length : 0);
      }, 0);

      const currentPage = pageInfo(response);
      if (!currentPage.hasMore) return { users, keys };
      if (!currentPage.nextCursor || currentPage.nextCursor === cursor) {
        throw new Error("Target returned an unusable next cursor");
      }
      cursor = currentPage.nextCursor;
    }
  }

  async createProviderGroup(payload: Record<string, unknown>): Promise<{ id: number }> {
    const result = (await this.request("/provider-groups", {
      method: "POST",
      body: JSON.stringify(payload),
    })) as Record<string, unknown>;
    return { id: positiveId(result.id, "provider group id") };
  }

  async createProvider(
    payload: Record<string, unknown>
  ): Promise<{ id: number; providerVendorId: number | null }> {
    const result = (await this.request("/providers", {
      method: "POST",
      body: JSON.stringify(payload),
    })) as Record<string, unknown>;
    return {
      id: positiveId(result.id, "provider id"),
      providerVendorId:
        result.providerVendorId == null
          ? null
          : positiveId(result.providerVendorId, "provider vendor id"),
    };
  }

  async revealProviderKey(providerId: number): Promise<string> {
    const result = (await this.request(`/providers/${providerId}/key:reveal`)) as {
      key?: unknown;
    };
    if (typeof result.key !== "string") throw new Error("Target omitted provider key");
    return result.key;
  }

  async updateProviderVendor(vendorId: number, payload: Record<string, unknown>): Promise<void> {
    await this.request(`/provider-vendors/${vendorId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  async upsertProviderEndpoint(
    vendorId: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    const query = encodeURIComponent(String(payload.providerType));
    const current = items(
      await this.request(`/provider-vendors/${vendorId}/endpoints?providerType=${query}`)
    );
    const existing = current.find(
      (endpoint) =>
        endpoint.url === payload.url && endpoint.providerType === payload.providerType
    );
    if (existing) {
      await this.request(`/provider-endpoints/${positiveId(existing.id, "endpoint id")}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: payload.label,
          sortOrder: payload.sortOrder,
          isEnabled: payload.isEnabled,
        }),
      });
      return;
    }
    await this.request(`/provider-vendors/${vendorId}/endpoints`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async createUser(payload: Record<string, unknown>): Promise<{ id: number }> {
    const result = await this.request("/users?withDefaultKey=false", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { id: extractCreatedUserId(result) };
  }

  async createUserKey(
    userId: number,
    payload: Record<string, unknown>
  ): Promise<{ id: number }> {
    const result = (await this.request(`/users/${userId}/keys`, {
      method: "POST",
      body: JSON.stringify(payload),
    })) as Record<string, unknown>;
    return { id: positiveId(result.id, "key id") };
  }

  async revealUserKey(keyId: number): Promise<string> {
    const result = (await this.request(`/keys/${keyId}:reveal`)) as { key?: unknown };
    if (typeof result.key !== "string") throw new Error("Target omitted user key");
    return result.key;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeTargetUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CONFIG_TRANSFER_TARGET_URL must use HTTPS or a loopback HTTP address");
  }
  return url.toString().replace(/\/$/, "");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const sourceDsn = requiredEnvironment("CONFIG_TRANSFER_SOURCE_DSN");
  const targetUrl = normalizeTargetUrl(requiredEnvironment("CONFIG_TRANSFER_TARGET_URL"));
  const targetToken = requiredEnvironment("CONFIG_TRANSFER_TARGET_ADMIN_TOKEN");
  const fingerprintKey = requiredEnvironment("CONFIG_TRANSFER_FINGERPRINT_KEY");
  const apply = args.includes("--apply");
  if (args.some((argument) => argument !== "--apply")) {
    throw new Error("Supported arguments: --apply (omit for dry-run)");
  }

  let sourceRows: ConfigurationSourceRows;
  try {
    sourceRows = await loadSourceRows(sourceDsn);
  } catch {
    throw new Error("Source database read-only preflight failed");
  }
  const snapshot = buildConfigurationTransferSnapshot(sourceRows);
  const report = await runConfigurationTransfer({
    snapshot,
    target: new ManagementApiTarget(targetUrl, targetToken),
    dryRun: !apply,
    fingerprintKey,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Configuration transfer failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
