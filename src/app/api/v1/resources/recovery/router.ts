import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import {
  RecoveryCapabilityOperationParamSchema,
  RecoveryCapabilityParamSchema,
  RecoveryConfigurationResponseSchema,
  RecoveryConfigurationUpdateSchema,
  RecoveryDiagnosticsSchema,
  RecoveryEndpointOperationParamSchema,
  RecoveryEndpointParamSchema,
  RecoveryOperationParamSchema,
  RecoveryOperationResponseSchema,
  RecoveryOperationSchema,
  RecoveryProviderConfigurationResponseSchema,
  RecoveryProviderConfigurationUpdateSchema,
  RecoveryProviderParamSchema,
  RecoveryVendorTypeOperationParamSchema,
  RecoveryVendorTypeParamSchema,
} from "@/lib/api/v1/schemas/recovery";
import {
  getCapabilityRecovery,
  getEndpointRecovery,
  getProviderRecovery,
  getVendorTypeRecovery,
  operateCapabilityRecovery,
  operateEndpointRecovery,
  operateProviderRecovery,
  operateVendorTypeRecovery,
  updateProviderRecoveryConfigurationHandler,
  updateRecoveryConfiguration,
} from "./handlers";

export const recoveryRouter = new OpenAPIHono();
const security: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];
const problems = {
  400: {
    description: "Invalid request.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  401: {
    description: "Authentication required.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  403: {
    description: "Admin access required.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  404: {
    description: "Recovery scope not found.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  409: {
    description: "Recovery state conflict.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  503: {
    description: "Recovery authority unavailable.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
} as const;

recoveryRouter.openapi(
  createRoute({
    method: "patch",
    path: "/recovery/providers/{providerId}/configuration",
    tags: ["Recovery"],
    summary: "Update provider recovery overrides",
    description: "Updates nullable provider-owned recovery and active-probe overrides.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: {
      params: RecoveryProviderParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: RecoveryProviderConfigurationUpdateSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated provider recovery overrides.",
        content: { "application/json": { schema: RecoveryProviderConfigurationResponseSchema } },
      },
      ...problems,
    },
  }),
  updateProviderRecoveryConfigurationHandler as never
);
recoveryRouter.openapi(
  createRoute({
    method: "get",
    path: "/recovery/providers/{providerId}",
    tags: ["Recovery"],
    summary: "Get provider recovery diagnostics",
    description: "Returns authoritative provider recovery state and effective configuration.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: { params: RecoveryProviderParamSchema },
    responses: {
      200: {
        description: "Recovery diagnostics.",
        content: { "application/json": { schema: RecoveryDiagnosticsSchema } },
      },
      ...problems,
    },
  }),
  getProviderRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "post",
    path: "/recovery/providers/{providerId}/actions/{action}",
    tags: ["Recovery"],
    summary: "Operate provider recovery",
    description: "Runs an epoch-fenced administrative operation for provider recovery.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: {
      params: RecoveryOperationParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: RecoveryOperationSchema } },
      },
    },
    responses: {
      200: {
        description: "Recovery operation result.",
        content: { "application/json": { schema: RecoveryOperationResponseSchema } },
      },
      ...problems,
    },
  }),
  operateProviderRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "get",
    path: "/recovery/providers/{providerId}/endpoints/{endpointId}",
    tags: ["Recovery"],
    summary: "Get endpoint recovery diagnostics",
    description: "Returns recovery diagnostics for one managed provider endpoint.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: { params: RecoveryEndpointParamSchema },
    responses: {
      200: {
        description: "Recovery diagnostics.",
        content: { "application/json": { schema: RecoveryDiagnosticsSchema } },
      },
      ...problems,
    },
  }),
  getEndpointRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "post",
    path: "/recovery/providers/{providerId}/endpoints/{endpointId}/actions/{action}",
    tags: ["Recovery"],
    summary: "Operate endpoint recovery",
    description: "Runs an epoch-fenced recovery operation for one managed endpoint.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: {
      params: RecoveryEndpointOperationParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: RecoveryOperationSchema } },
      },
    },
    responses: {
      200: {
        description: "Recovery operation result.",
        content: { "application/json": { schema: RecoveryOperationResponseSchema } },
      },
      ...problems,
    },
  }),
  operateEndpointRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "get",
    path: "/recovery/vendors/{vendorId}/types/{providerType}",
    tags: ["Recovery"],
    summary: "Get vendor type recovery diagnostics",
    description: "Returns recovery diagnostics for one vendor and provider-type scope.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: { params: RecoveryVendorTypeParamSchema },
    responses: {
      200: {
        description: "Recovery diagnostics.",
        content: { "application/json": { schema: RecoveryDiagnosticsSchema } },
      },
      ...problems,
    },
  }),
  getVendorTypeRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "post",
    path: "/recovery/vendors/{vendorId}/types/{providerType}/actions/{action}",
    tags: ["Recovery"],
    summary: "Operate vendor type recovery",
    description: "Runs an epoch-fenced recovery operation for a vendor-type scope.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: {
      params: RecoveryVendorTypeOperationParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: RecoveryOperationSchema } },
      },
    },
    responses: {
      200: {
        description: "Recovery operation result.",
        content: { "application/json": { schema: RecoveryOperationResponseSchema } },
      },
      ...problems,
    },
  }),
  operateVendorTypeRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "get",
    path: "/recovery/providers/{providerId}/capabilities/{modelFamily}/{transport}",
    tags: ["Recovery"],
    summary: "Get capability recovery diagnostics",
    description: "Returns recovery diagnostics for a provider capability and transport.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: { params: RecoveryCapabilityParamSchema },
    responses: {
      200: {
        description: "Recovery diagnostics.",
        content: { "application/json": { schema: RecoveryDiagnosticsSchema } },
      },
      ...problems,
    },
  }),
  getCapabilityRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "post",
    path: "/recovery/providers/{providerId}/capabilities/{modelFamily}/{transport}/actions/{action}",
    tags: ["Recovery"],
    summary: "Operate capability recovery",
    description: "Runs an epoch-fenced recovery operation for a provider capability.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: {
      params: RecoveryCapabilityOperationParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: RecoveryOperationSchema } },
      },
    },
    responses: {
      200: {
        description: "Recovery operation result.",
        content: { "application/json": { schema: RecoveryOperationResponseSchema } },
      },
      ...problems,
    },
  }),
  operateCapabilityRecovery as never
);
recoveryRouter.openapi(
  createRoute({
    method: "patch",
    path: "/recovery/configuration",
    tags: ["Recovery"],
    summary: "Update recovery configuration",
    description: "Updates nullable system recovery settings and reloads recovery authority.",
    "x-required-access": "admin",
    middleware: requireAuth("admin"),
    security,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: RecoveryConfigurationUpdateSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated recovery configuration.",
        content: { "application/json": { schema: RecoveryConfigurationResponseSchema } },
      },
      ...problems,
    },
  }),
  updateRecoveryConfiguration as never
);
