import { createHmac, timingSafeEqual } from "node:crypto";

type SourceRow = Record<string, unknown>;

export interface ConfigurationSourceRows {
  providerGroups: SourceRow[];
  providerVendors: SourceRow[];
  providers: SourceRow[];
  providerEndpoints: SourceRow[];
  users: SourceRow[];
  keys: SourceRow[];
}

export type ConfigurationTransferSnapshot = ConfigurationSourceRows;

export interface ConfigurationCounts {
  providerGroups: number;
  providers: number;
  providerVendors: number;
  providerEndpoints: number;
  users: number;
  keys: number;
}

export interface ConfigurationTransferReport {
  mode: "dry-run" | "import";
  counts: ConfigurationCounts;
  fingerprints: { providerKeys: string; userKeys: string };
}

export interface ConfigurationTransferTarget {
  countConfiguration(): Promise<ConfigurationCounts>;
  createProviderGroup(payload: Record<string, unknown>): Promise<{ id: number }>;
  createProvider(
    payload: Record<string, unknown>
  ): Promise<{ id: number; providerVendorId: number | null }>;
  revealProviderKey(providerId: number): Promise<string>;
  updateProviderVendor(vendorId: number, payload: Record<string, unknown>): Promise<void>;
  upsertProviderEndpoint(vendorId: number, payload: Record<string, unknown>): Promise<void>;
  createUser(payload: Record<string, unknown>): Promise<{ id: number }>;
  createUserKey(userId: number, payload: Record<string, unknown>): Promise<{ id: number }>;
  revealUserKey(keyId: number): Promise<string>;
}

const SUPPORTED_PROVIDER_TYPES = new Set([
  "claude",
  "claude-auth",
  "codex",
  "gemini",
  "gemini-cli",
  "openai-compatible",
]);

const PROVIDER_FIELDS = [
  "name",
  "url",
  "key",
  "is_enabled",
  "weight",
  "priority",
  "group_priorities",
  "cost_multiplier",
  "group_tag",
  "provider_type",
  "preserve_client_ip",
  "disable_session_reuse",
  "model_redirects",
  "active_time_start",
  "active_time_end",
  "allowed_models",
  "allowed_clients",
  "blocked_clients",
  "mcp_passthrough_type",
  "mcp_passthrough_url",
  "limit_5h_usd",
  "limit_5h_reset_mode",
  "limit_daily_usd",
  "daily_reset_mode",
  "daily_reset_time",
  "limit_weekly_usd",
  "limit_monthly_usd",
  "limit_total_usd",
  "limit_concurrent_sessions",
  "max_retry_attempts",
  "circuit_breaker_failure_threshold",
  "circuit_breaker_open_duration",
  "circuit_breaker_half_open_success_threshold",
  "proxy_url",
  "proxy_fallback_to_direct",
  "custom_headers",
  "first_byte_timeout_streaming_ms",
  "streaming_idle_timeout_ms",
  "request_timeout_non_streaming_ms",
  "website_url",
  "favicon_url",
  "cache_ttl_preference",
  "swap_cache_ttl_billing",
  "context_1m_preference",
  "codex_reasoning_effort_preference",
  "codex_reasoning_summary_preference",
  "codex_text_verbosity_preference",
  "codex_parallel_tool_calls_preference",
  "codex_image_generation_preference",
  "codex_service_tier_preference",
  "codex_compaction_v2_capability",
  "anthropic_max_tokens_preference",
  "anthropic_thinking_budget_preference",
  "anthropic_adaptive_thinking",
  "gemini_google_search_preference",
] as const;

const NUMERIC_PROVIDER_FIELDS = new Set([
  "cost_multiplier",
  "limit_5h_usd",
  "limit_daily_usd",
  "limit_weekly_usd",
  "limit_monthly_usd",
  "limit_total_usd",
]);

function rowId(row: SourceRow): number {
  const value = Number(row.id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid source identifier");
  return value;
}

function foreignId(row: SourceRow, field: string): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid source relationship: ${field}`);
  }
  return value;
}

function isActive(row: SourceRow): boolean {
  return row.deleted_at == null && row.deletedAt == null;
}

function valueOrUndefined(value: unknown): unknown {
  return value == null ? undefined : value;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid numeric configuration value");
  return number;
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid configuration timestamp");
  return date.toISOString();
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function buildConfigurationTransferSnapshot(
  rows: ConfigurationSourceRows
): ConfigurationTransferSnapshot {
  const providers = rows.providers.filter(isActive);
  const users = rows.users.filter(isActive);
  const retainedUserIds = new Set(users.map(rowId));
  const keys = rows.keys.filter(
    (row) => isActive(row) && retainedUserIds.has(foreignId(row, "user_id"))
  );
  const providerEndpoints = rows.providerEndpoints.filter(isActive);

  const retainedVendorIds = new Set<number>();
  for (const provider of providers) {
    retainedVendorIds.add(foreignId(provider, "provider_vendor_id"));
  }
  for (const endpoint of providerEndpoints) {
    retainedVendorIds.add(foreignId(endpoint, "vendor_id"));
  }

  const providerVendors = rows.providerVendors.filter((row) => retainedVendorIds.has(rowId(row)));
  if (providerVendors.length !== retainedVendorIds.size) {
    throw new Error("Retained configuration references a missing provider vendor");
  }

  return {
    providerGroups: rows.providerGroups.filter(isActive),
    providerVendors,
    providers,
    providerEndpoints,
    users,
    keys,
  };
}

function snapshotCounts(snapshot: ConfigurationTransferSnapshot): ConfigurationCounts {
  return {
    providerGroups: snapshot.providerGroups.length,
    providers: snapshot.providers.length,
    providerVendors: snapshot.providerVendors.length,
    providerEndpoints: snapshot.providerEndpoints.length,
    users: snapshot.users.length,
    keys: snapshot.keys.length,
  };
}

function aggregateFingerprint(rows: SourceRow[], key: string, domain: string): string {
  const hmac = createHmac("sha256", key);
  const ordered = rows
    .map((row) => `${rowId(row)}\0${String(row.key ?? "")}`)
    .sort((a, b) => a.localeCompare(b));
  hmac.update(domain);
  for (const value of ordered) hmac.update("\0").update(value);
  return hmac.digest("hex").slice(0, 20);
}

export function summarizeConfigurationTransfer(
  snapshot: ConfigurationTransferSnapshot,
  fingerprintKey: string,
  mode: ConfigurationTransferReport["mode"]
): ConfigurationTransferReport {
  if (fingerprintKey.length < 16) {
    throw new Error("CONFIG_TRANSFER_FINGERPRINT_KEY must contain at least 16 characters");
  }
  return {
    mode,
    counts: snapshotCounts(snapshot),
    fingerprints: {
      providerKeys: aggregateFingerprint(snapshot.providers, fingerprintKey, "provider-keys"),
      userKeys: aggregateFingerprint(snapshot.keys, fingerprintKey, "user-keys"),
    },
  };
}

function assertTargetEmpty(counts: ConfigurationCounts): void {
  if (Object.values(counts).some((count) => count !== 0)) {
    throw new Error("Target contains provider or user configuration; recreate it before import");
  }
}

function providerPayload(row: SourceRow): Record<string, unknown> {
  const providerType = String(row.provider_type ?? "claude");
  if (!SUPPORTED_PROVIDER_TYPES.has(providerType)) {
    throw new Error(`Unsupported source provider type: ${providerType}`);
  }
  const payload: Record<string, unknown> = {};
  for (const field of PROVIDER_FIELDS) {
    const value = row[field];
    payload[field] = NUMERIC_PROVIDER_FIELDS.has(field)
      ? numberOrNull(value)
      : valueOrUndefined(value);
  }
  payload.provider_type = providerType;
  payload.codex_compaction_v2_capability =
    row.codex_compaction_v2_capability ?? "legacy_adapter";
  payload.allowed_clients = row.allowed_clients ?? [];
  payload.blocked_clients = row.blocked_clients ?? [];
  return compactObject(payload);
}

function providerGroupPayload(row: SourceRow): Record<string, unknown> {
  return compactObject({
    name: row.name,
    costMultiplier: numberOrNull(row.cost_multiplier),
    description: valueOrUndefined(row.description),
  });
}

function vendorPayload(row: SourceRow): Record<string, unknown> {
  return compactObject({
    displayName: valueOrUndefined(row.display_name),
    websiteUrl: valueOrUndefined(row.website_url),
  });
}

function endpointPayload(row: SourceRow): Record<string, unknown> {
  const providerType = String(row.provider_type ?? "claude");
  if (!SUPPORTED_PROVIDER_TYPES.has(providerType)) {
    throw new Error(`Unsupported source endpoint provider type: ${providerType}`);
  }
  return compactObject({
    providerType,
    url: row.url,
    label: valueOrUndefined(row.label),
    sortOrder: numberOrNull(row.sort_order),
    isEnabled: valueOrUndefined(row.is_enabled),
  });
}

function userPayload(row: SourceRow): Record<string, unknown> {
  if (row.role != null && row.role !== "user") {
    throw new Error(`Unsupported source user role: ${String(row.role)}`);
  }
  return compactObject({
    name: row.name,
    note: valueOrUndefined(row.description),
    providerGroup: valueOrUndefined(row.provider_group),
    tags: row.tags ?? [],
    rpm: numberOrNull(row.rpm_limit),
    dailyQuota: numberOrNull(row.daily_limit_usd),
    limit5hUsd: numberOrNull(row.limit_5h_usd),
    limit5hResetMode: valueOrUndefined(row.limit_5h_reset_mode),
    limitWeeklyUsd: numberOrNull(row.limit_weekly_usd),
    limitMonthlyUsd: numberOrNull(row.limit_monthly_usd),
    limitTotalUsd: numberOrNull(row.limit_total_usd),
    limitConcurrentSessions: numberOrNull(row.limit_concurrent_sessions),
    dailyResetMode: valueOrUndefined(row.daily_reset_mode),
    dailyResetTime: valueOrUndefined(row.daily_reset_time),
    isEnabled: valueOrUndefined(row.is_enabled),
    expiresAt: isoOrNull(row.expires_at),
    allowedClients: row.allowed_clients ?? [],
    blockedClients: row.blocked_clients ?? [],
    allowedModels: row.allowed_models ?? [],
  });
}

function keyPayload(row: SourceRow): Record<string, unknown> {
  return compactObject({
    name: row.name,
    key: row.key,
    expiresAt: isoOrNull(row.expires_at),
    isEnabled: valueOrUndefined(row.is_enabled),
    canLoginWebUi: valueOrUndefined(row.can_login_web_ui),
    limit5hUsd: numberOrNull(row.limit_5h_usd),
    limit5hResetMode: valueOrUndefined(row.limit_5h_reset_mode),
    limitDailyUsd: numberOrNull(row.limit_daily_usd),
    dailyResetMode: valueOrUndefined(row.daily_reset_mode),
    dailyResetTime: valueOrUndefined(row.daily_reset_time),
    limitWeeklyUsd: numberOrNull(row.limit_weekly_usd),
    limitMonthlyUsd: numberOrNull(row.limit_monthly_usd),
    limitTotalUsd: numberOrNull(row.limit_total_usd),
    limitConcurrentSessions:
      row.limit_concurrent_sessions == null
        ? undefined
        : numberOrNull(row.limit_concurrent_sessions),
    providerGroup: valueOrUndefined(row.provider_group),
    cacheTtlPreference: valueOrUndefined(row.cache_ttl_preference),
  });
}

function secretsEqual(expected: unknown, actual: unknown): boolean {
  const expectedBuffer = Buffer.from(String(expected ?? ""));
  const actualBuffer = Buffer.from(String(actual ?? ""));
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export async function runConfigurationTransfer(options: {
  snapshot: ConfigurationTransferSnapshot;
  target: ConfigurationTransferTarget;
  dryRun: boolean;
  fingerprintKey: string;
}): Promise<ConfigurationTransferReport> {
  assertTargetEmpty(await options.target.countConfiguration());
  const report = summarizeConfigurationTransfer(
    options.snapshot,
    options.fingerprintKey,
    options.dryRun ? "dry-run" : "import"
  );
  if (options.dryRun) return report;

  let stage = "provider groups";
  try {
    for (const group of options.snapshot.providerGroups) {
      await options.target.createProviderGroup(providerGroupPayload(group));
    }

    stage = "providers";
    const vendorIdMap = new Map<number, number>();
    for (const provider of options.snapshot.providers) {
      const created = await options.target.createProvider(providerPayload(provider));
      if (created.providerVendorId == null) throw new Error("Target provider has no vendor");
      const sourceVendorId = foreignId(provider, "provider_vendor_id");
      const mapped = vendorIdMap.get(sourceVendorId);
      if (mapped !== undefined && mapped !== created.providerVendorId) {
        throw new Error("Source vendor mapped to multiple target vendors");
      }
      vendorIdMap.set(sourceVendorId, created.providerVendorId);
      const revealed = await options.target.revealProviderKey(created.id);
      if (!secretsEqual(provider.key, revealed)) throw new Error("Provider key verification failed");
    }

    stage = "provider vendors and endpoints";
    for (const vendor of options.snapshot.providerVendors) {
      const targetVendorId = vendorIdMap.get(rowId(vendor));
      if (targetVendorId === undefined) {
        throw new Error("Cannot establish target vendor without a retained provider");
      }
      await options.target.updateProviderVendor(targetVendorId, vendorPayload(vendor));
    }
    for (const endpoint of options.snapshot.providerEndpoints) {
      const targetVendorId = vendorIdMap.get(foreignId(endpoint, "vendor_id"));
      if (targetVendorId === undefined) throw new Error("Endpoint vendor mapping is unavailable");
      await options.target.upsertProviderEndpoint(targetVendorId, endpointPayload(endpoint));
    }

    stage = "users and keys";
    const userIdMap = new Map<number, number>();
    for (const user of options.snapshot.users) {
      const created = await options.target.createUser(userPayload(user));
      userIdMap.set(rowId(user), created.id);
    }
    for (const key of options.snapshot.keys) {
      const targetUserId = userIdMap.get(foreignId(key, "user_id"));
      if (targetUserId === undefined) throw new Error("Key user mapping is unavailable");
      const created = await options.target.createUserKey(targetUserId, keyPayload(key));
      const revealed = await options.target.revealUserKey(created.id);
      if (!secretsEqual(key.key, revealed)) throw new Error("User key verification failed");
    }
  } catch {
    throw new Error(
      `Configuration transfer failed during ${stage}; recreate the isolated target and rerun`
    );
  }

  return report;
}
