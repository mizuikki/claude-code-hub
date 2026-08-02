import type { Context } from "hono";
import { createProblemResponse, fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { jsonResponse } from "@/lib/api/v1/_shared/response-helpers";
import {
  RecoveryCapabilityOperationParamSchema,
  RecoveryCapabilityParamSchema,
  RecoveryConfigurationUpdateSchema,
  RecoveryEndpointOperationParamSchema,
  RecoveryEndpointParamSchema,
  RecoveryOperationParamSchema,
  RecoveryOperationSchema,
  RecoveryProviderConfigurationUpdateSchema,
  RecoveryProviderParamSchema,
  RecoveryVendorTypeOperationParamSchema,
  RecoveryVendorTypeParamSchema,
} from "@/lib/api/v1/schemas/recovery";
import { emitActionAudit } from "@/lib/audit/emit";
import {
  authorityTransitionRequiresProof,
  bindingAuthorityTransitionAllowed,
} from "@/lib/recovery/authority";
import {
  getCachedRecoveryConfiguration,
  invalidateRecoveryConfiguration,
} from "@/lib/recovery/config-cache";
import type { RecoveryScope } from "@/lib/recovery/contracts";
import {
  getRecoveryManagementService,
  initializeRecoveryRuntime,
  recoveryRuntimeIsDegraded,
  runRecoveryProbe,
} from "@/lib/recovery/runtime";
import { hashRecoveryScope } from "@/lib/recovery/scope";
import {
  getPersistedRecoveryConfiguration,
  updateProviderRecoveryConfiguration,
  updateSystemRecoveryConfiguration,
} from "@/repository/recovery-config";

function parseParams<T>(
  schema: {
    safeParse(
      value: unknown
    ): { success: true; data: T } | { success: false; error: Parameters<typeof fromZodError>[0] };
  },
  value: unknown,
  c: Context
): T | Response {
  const result = schema.safeParse(value);
  return result.success ? result.data : fromZodError(result.error, new URL(c.req.url).pathname);
}

export async function getProviderRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryProviderParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  const scope = { kind: "provider" as const, providerId: params.providerId };
  const [persisted, configuration] = await Promise.all([
    getPersistedRecoveryConfiguration(params.providerId),
    getCachedRecoveryConfiguration(params.providerId),
  ]);
  const service = getRecoveryManagementService();
  const state = service ? await service.getState(scope) : null;
  return jsonResponse({
    scope,
    state,
    configuration,
    authority: {
      recovery: persisted.system.recoveryAuthorityMode ?? "legacy",
      binding: persisted.system.sessionBindingAuthorityMode ?? "legacy",
    },
    degraded:
      recoveryRuntimeIsDegraded() ||
      (!service &&
        (persisted.system.recoveryAuthorityMode === "enforce" ||
          persisted.system.sessionBindingAuthorityMode === "v2_only")),
  });
}

async function diagnosticsForScope(scope: RecoveryScope): Promise<Response> {
  const providerId = scope.kind === "vendor-type" ? undefined : scope.providerId;
  const [persisted, configuration] = await Promise.all([
    getPersistedRecoveryConfiguration(providerId),
    getCachedRecoveryConfiguration(providerId),
  ]);
  const service = getRecoveryManagementService();
  return jsonResponse({
    scope,
    state: service ? await service.getState(scope) : null,
    configuration,
    authority: {
      recovery: persisted.system.recoveryAuthorityMode ?? "legacy",
      binding: persisted.system.sessionBindingAuthorityMode ?? "legacy",
    },
    degraded: recoveryRuntimeIsDegraded(),
  });
}

function emitRecoveryOperationAudit(input: {
  action: "probe" | "pause" | "resume" | "reset" | "force_open" | "force_close";
  scope: RecoveryScope;
  expectedEpoch: number;
  reason: string;
  result: { readonly code: string };
}): void {
  const audit = {
    category: "provider" as const,
    targetType: "recovery_scope",
    targetId: hashRecoveryScope(input.scope),
    before: { expectedEpoch: input.expectedEpoch, reason: input.reason },
    after: input.result,
    success: input.result.code === "applied" || input.result.code === "duplicate",
  };
  if (input.action === "probe") emitActionAudit({ ...audit, action: "recovery.probe" });
  else if (input.action === "pause") emitActionAudit({ ...audit, action: "recovery.pause" });
  else if (input.action === "resume") emitActionAudit({ ...audit, action: "recovery.resume" });
  else if (input.action === "reset") emitActionAudit({ ...audit, action: "recovery.reset" });
  else if (input.action === "force_open")
    emitActionAudit({ ...audit, action: "recovery.force_open" });
  else emitActionAudit({ ...audit, action: "recovery.force_close" });
}

export async function getEndpointRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryEndpointParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return diagnosticsForScope({
    kind: "endpoint",
    providerId: params.providerId,
    endpoint: { kind: "managed", endpointId: params.endpointId },
  });
}

export async function getVendorTypeRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryVendorTypeParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return diagnosticsForScope({
    kind: "vendor-type",
    vendorId: params.vendorId,
    providerType: params.providerType,
  });
}

export async function getCapabilityRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryCapabilityParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return diagnosticsForScope({
    kind: "capability",
    providerId: params.providerId,
    modelFamily: params.modelFamily,
    transport: params.transport,
  });
}

async function operateScope(
  c: Context,
  scope: RecoveryScope,
  actionValue: string
): Promise<Response> {
  const bodyResult = RecoveryOperationSchema.safeParse(await c.req.json().catch(() => null));
  if (!bodyResult.success) return fromZodError(bodyResult.error, new URL(c.req.url).pathname);
  const action = actionValue.replace("-", "_") as
    | "probe"
    | "pause"
    | "resume"
    | "reset"
    | "force_open"
    | "force_close";
  const service = getRecoveryManagementService();
  if (!service)
    return createProblemResponse({
      status: 503,
      instance: new URL(c.req.url).pathname,
      errorCode: "recovery.unavailable",
      detail: "Recovery authority is unavailable.",
    });
  const result =
    action === "probe"
      ? await runRecoveryProbe(scope, bodyResult.data.expectedEpoch)
      : await service.administrate({
          scope,
          action,
          expectedEpoch: bodyResult.data.expectedEpoch,
          reason: bodyResult.data.reason,
          confirmation: bodyResult.data.confirmation,
        });
  emitRecoveryOperationAudit({
    action,
    scope,
    expectedEpoch: bodyResult.data.expectedEpoch,
    reason: bodyResult.data.reason,
    result,
  });
  if (result.code === "stale_epoch")
    return createProblemResponse({
      status: 409,
      instance: new URL(c.req.url).pathname,
      errorCode: "recovery.stale_epoch",
      detail: "Recovery epoch is stale.",
    });
  if (result.code === "confirmation_required")
    return createProblemResponse({
      status: 409,
      instance: new URL(c.req.url).pathname,
      errorCode: "recovery.confirmation_required",
      detail: "Force close confirmation is required.",
    });
  if (result.code !== "applied" && result.code !== "duplicate")
    return createProblemResponse({
      status: result.code === "not_found" ? 404 : 409,
      instance: new URL(c.req.url).pathname,
      errorCode: `recovery.${result.code}`,
      detail: "Recovery operation was rejected by the authoritative state.",
    });
  return jsonResponse({ code: result.code, epoch: result.epoch, health: result.health });
}

export async function operateProviderRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryOperationParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return operateScope(c, { kind: "provider", providerId: params.providerId }, params.action);
}

export async function operateEndpointRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryEndpointOperationParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return operateScope(
    c,
    {
      kind: "endpoint",
      providerId: params.providerId,
      endpoint: { kind: "managed", endpointId: params.endpointId },
    },
    params.action
  );
}

export async function operateVendorTypeRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryVendorTypeOperationParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return operateScope(
    c,
    { kind: "vendor-type", vendorId: params.vendorId, providerType: params.providerType },
    params.action
  );
}

export async function operateCapabilityRecovery(c: Context): Promise<Response> {
  const params = parseParams(RecoveryCapabilityOperationParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  return operateScope(
    c,
    {
      kind: "capability",
      providerId: params.providerId,
      modelFamily: params.modelFamily,
      transport: params.transport,
    },
    params.action
  );
}

export async function updateRecoveryConfiguration(c: Context): Promise<Response> {
  const parsed = RecoveryConfigurationUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fromZodError(parsed.error, new URL(c.req.url).pathname);
  const before = await getPersistedRecoveryConfiguration();
  const currentRecovery = before.system.recoveryAuthorityMode ?? "legacy";
  const currentBinding = before.system.sessionBindingAuthorityMode ?? "legacy";
  const nextRecovery = parsed.data.recoveryAuthorityMode ?? currentRecovery;
  const nextBinding = parsed.data.sessionBindingAuthorityMode ?? currentBinding;
  if (!bindingAuthorityTransitionAllowed({ current: currentBinding, next: nextBinding })) {
    return createProblemResponse({
      status: 409,
      instance: new URL(c.req.url).pathname,
      errorCode: "recovery.binding_authority_transition_invalid",
      detail: "Binding authority transitions must follow the staged dual-write rollout path.",
    });
  }
  if (
    authorityTransitionRequiresProof({
      currentRecovery,
      nextRecovery,
      currentBinding,
      nextBinding,
    }) &&
    !parsed.data.rolloutProof
  ) {
    return createProblemResponse({
      status: 409,
      instance: new URL(c.req.url).pathname,
      errorCode: "recovery.rollout_gate_required",
      detail: "Fleet replacement proof or a maintenance window is required for this transition.",
    });
  }
  const { rolloutProof, ...configurationUpdates } = parsed.data;
  const after = await updateSystemRecoveryConfiguration(configurationUpdates);
  invalidateRecoveryConfiguration();
  await initializeRecoveryRuntime();
  emitActionAudit({
    category: "system_settings",
    action: "recovery.configuration.update",
    targetType: "system",
    before: before.system,
    after: { ...after, rolloutProof: rolloutProof ?? null },
    success: true,
  });
  return jsonResponse(after);
}

export async function updateProviderRecoveryConfigurationHandler(c: Context): Promise<Response> {
  const params = parseParams(RecoveryProviderParamSchema, c.req.param(), c);
  if (params instanceof Response) return params;
  const parsed = RecoveryProviderConfigurationUpdateSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) return fromZodError(parsed.error, new URL(c.req.url).pathname);
  const before = await getPersistedRecoveryConfiguration(params.providerId);
  const after = await updateProviderRecoveryConfiguration(params.providerId, parsed.data);
  if (!after) {
    return createProblemResponse({
      status: 404,
      instance: new URL(c.req.url).pathname,
      errorCode: "provider.not_found",
      detail: "Provider not found.",
    });
  }
  invalidateRecoveryConfiguration(params.providerId);
  emitActionAudit({
    category: "provider",
    action: "recovery.configuration.update",
    targetType: "provider",
    targetId: String(params.providerId),
    before: before.provider,
    after,
    success: true,
  });
  return jsonResponse(after);
}
