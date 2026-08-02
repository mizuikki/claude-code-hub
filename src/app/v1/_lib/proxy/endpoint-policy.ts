import type { EndpointRecoveryPolicy, MigrationSafety } from "@/lib/recovery/contracts";
import { resolveEndpointFamilyByPath } from "./endpoint-family-catalog";
import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";

export type EndpointGuardPreset = "chat" | "raw_passthrough";

export type EndpointPoolStrictness = "inherit" | "strict";

export interface EndpointPolicy extends EndpointRecoveryPolicy {
  readonly kind: "default" | "raw_passthrough";
  readonly guardPreset: EndpointGuardPreset;
  readonly allowRetry: boolean;
  readonly allowProviderSwitch: boolean;
  readonly allowRawCrossProviderFallback: boolean;
  readonly allowCircuitBreakerAccounting: boolean;
  readonly trackConcurrentRequests: boolean;
  readonly bypassRequestFilters: boolean;
  readonly bypassForwarderPreprocessing: boolean;
  readonly bypassSpecialSettings: boolean;
  readonly bypassResponseRectifier: boolean;
  readonly endpointPoolStrictness: EndpointPoolStrictness;
}

const DEFAULT_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
  kind: "default",
  guardPreset: "chat",
  allowRetry: true,
  allowProviderSwitch: true,
  allowRawCrossProviderFallback: false,
  allowCircuitBreakerAccounting: true,
  trackConcurrentRequests: true,
  bypassRequestFilters: false,
  bypassForwarderPreprocessing: false,
  bypassSpecialSettings: false,
  bypassResponseRectifier: false,
  endpointPoolStrictness: "inherit",
  recoveryEvidence: "business",
  halfOpenEligible: true,
  retrySafety: "pre_commit_only",
  migrationSafety: "replayable",
  trackSessionBinding: true,
});

const RAW_PASSTHROUGH_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
  kind: "raw_passthrough",
  guardPreset: "raw_passthrough",
  allowRetry: false,
  allowProviderSwitch: false,
  allowRawCrossProviderFallback: true,
  allowCircuitBreakerAccounting: false,
  trackConcurrentRequests: false,
  bypassRequestFilters: true,
  bypassForwarderPreprocessing: true,
  bypassSpecialSettings: true,
  bypassResponseRectifier: true,
  endpointPoolStrictness: "strict",
  recoveryEvidence: "none",
  halfOpenEligible: false,
  retrySafety: "never",
  migrationSafety: "provider_bound",
  trackSessionBinding: false,
});

const CONNECTIVITY_POLICY: EndpointPolicy = Object.freeze({
  ...DEFAULT_ENDPOINT_POLICY,
  recoveryEvidence: "connectivity",
  halfOpenEligible: false,
  retrySafety: "idempotent",
  migrationSafety: "unknown",
  trackSessionBinding: false,
});

const STATELESS_BUSINESS_POLICY: EndpointPolicy = Object.freeze({
  ...DEFAULT_ENDPOINT_POLICY,
  retrySafety: "idempotent",
  migrationSafety: "replayable",
  trackSessionBinding: false,
});

const RESOURCE_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
  ...DEFAULT_ENDPOINT_POLICY,
  allowRetry: false,
  allowProviderSwitch: false,
  recoveryEvidence: "none",
  halfOpenEligible: false,
  retrySafety: "never",
  migrationSafety: "provider_bound",
  trackSessionBinding: false,
});

const rawPassthroughEndpointPathSet = new Set<string>([
  V1_ENDPOINT_PATHS.MESSAGES_COUNT_TOKENS,
  V1_ENDPOINT_PATHS.RESPONSES_COMPACT,
]);

export function isRawPassthroughEndpointPath(pathname: string): boolean {
  return rawPassthroughEndpointPathSet.has(normalizeEndpointPath(pathname));
}

export function isRawPassthroughEndpointPolicy(policy: EndpointPolicy): boolean {
  return policy.kind === "raw_passthrough";
}

export function isStrictEndpointPoolPolicy(policy: Pick<EndpointPolicy, "endpointPoolStrictness">) {
  return policy.endpointPoolStrictness === "strict";
}

export function shouldEnforceStrictEndpointPoolPolicy(
  policy: Pick<EndpointPolicy, "endpointPoolStrictness">
) {
  return policy.endpointPoolStrictness === "strict" || policy.endpointPoolStrictness === "inherit";
}

export function resolveEndpointPolicy(pathname: string): EndpointPolicy {
  const normalizedPath = normalizeEndpointPath(pathname);

  if (rawPassthroughEndpointPathSet.has(normalizedPath)) {
    return RAW_PASSTHROUGH_ENDPOINT_POLICY;
  }

  if (
    normalizedPath === V1_ENDPOINT_PATHS.MODELS ||
    normalizedPath === V1_ENDPOINT_PATHS.MESSAGES_COUNT_TOKENS
  ) {
    return CONNECTIVITY_POLICY;
  }

  if (normalizedPath === V1_ENDPOINT_PATHS.EMBEDDINGS) return STATELESS_BUSINESS_POLICY;

  if (
    normalizedPath === V1_ENDPOINT_PATHS.MESSAGES ||
    normalizedPath === V1_ENDPOINT_PATHS.RESPONSES ||
    normalizedPath === V1_ENDPOINT_PATHS.CHAT_COMPLETIONS
  ) {
    return DEFAULT_ENDPOINT_POLICY;
  }

  if (resolveEndpointFamilyByPath(normalizedPath)) return RESOURCE_ENDPOINT_POLICY;

  return RAW_PASSTHROUGH_ENDPOINT_POLICY;
}

const PROVIDER_BOUND_FIELDS = new Set([
  "previous_response_id",
  "conversation",
  "conversation_id",
  "thread_id",
  "file_id",
  "upload_id",
  "batch_id",
  "encrypted_content",
  "tools",
  "tool_choice",
]);

function containsProviderBoundArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsProviderBoundArtifact);
  return Object.entries(value).some(
    ([key, nested]) =>
      (PROVIDER_BOUND_FIELDS.has(key) && nested !== null && nested !== undefined) ||
      containsProviderBoundArtifact(nested)
  );
}

export function tightenEndpointRecoveryPolicy(
  policy: EndpointPolicy,
  input: { readonly body: unknown; readonly transport: "http" | "websocket" }
): EndpointPolicy {
  let migrationSafety: MigrationSafety = policy.migrationSafety;
  if (input.transport === "websocket" || containsProviderBoundArtifact(input.body)) {
    migrationSafety = "provider_bound";
  }
  if (migrationSafety === policy.migrationSafety) return policy;
  return Object.freeze({
    ...policy,
    migrationSafety,
    retrySafety: "never",
    halfOpenEligible: false,
  });
}
