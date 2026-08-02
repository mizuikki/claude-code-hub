import { apiClient } from "@/lib/api-client/v1/client";

export interface ProviderRecoveryDiagnostics {
  scope: unknown;
  state: {
    health: string;
    epoch: number;
    automationPaused: boolean;
    recoveryStageIndex: number;
    failureCount: number;
    trialOccupancy: number;
    nextProbeAt: number | null;
    probeLeaseUntil: number | null;
    probeAttemptCount: number;
    window: { total: number; success: number; failure: number; slow: number; hard: number };
  } | null;
  configuration: Record<
    string,
    Record<string, { effective: unknown; configured: unknown; source: string }>
  >;
  authority: { recovery: string; binding: string };
  degraded: boolean;
}

export function getProviderRecoveryDiagnostics(providerId: number) {
  return apiClient.get<ProviderRecoveryDiagnostics>(`/api/v1/recovery/providers/${providerId}`);
}

export function operateProviderRecovery(
  providerId: number,
  action: "probe" | "pause" | "resume" | "reset" | "force-open" | "force-close",
  input: { expectedEpoch: number; reason: string; confirmation?: "FORCE_CLOSE" }
) {
  return apiClient.post<{ code: string; epoch: number; health: string }>(
    `/api/v1/recovery/providers/${providerId}/actions/${action}`,
    input
  );
}

export function getEndpointRecoveryDiagnostics(providerId: number, endpointId: number) {
  return apiClient.get<ProviderRecoveryDiagnostics>(
    `/api/v1/recovery/providers/${providerId}/endpoints/${endpointId}`
  );
}

export function getVendorTypeRecoveryDiagnostics(vendorId: number, providerType: string) {
  return apiClient.get<ProviderRecoveryDiagnostics>(
    `/api/v1/recovery/vendors/${vendorId}/types/${encodeURIComponent(providerType)}`
  );
}

export function getCapabilityRecoveryDiagnostics(
  providerId: number,
  modelFamily: string,
  transport: string
) {
  return apiClient.get<ProviderRecoveryDiagnostics>(
    `/api/v1/recovery/providers/${providerId}/capabilities/${encodeURIComponent(modelFamily)}/${encodeURIComponent(transport)}`
  );
}

export function updateRecoveryConfiguration(input: unknown) {
  return apiClient.patch("/api/v1/recovery/configuration", input);
}

export function updateProviderRecoveryConfiguration(providerId: number, input: unknown) {
  return apiClient.patch(`/api/v1/recovery/providers/${providerId}/configuration`, input);
}
