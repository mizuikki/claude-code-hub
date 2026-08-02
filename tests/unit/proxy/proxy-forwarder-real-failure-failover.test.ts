import { createServer } from "node:http";
import type { Socket } from "node:net";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(async () => ({
    allowNonConversationEndpointProviderFallback: true,
    billHedgeLosers: false,
    enableBillingHeaderRectifier: false,
    enableClaudeMetadataUserIdInjection: false,
    enableResponseFixer: false,
    enableResponseInputRectifier: true,
    enableThinkingBudgetRectifier: true,
    enableThinkingSignatureRectifier: true,
  })),
  isHttp2Enabled: vi.fn(async () => false),
  getPreferredProviderEndpoints: vi.fn(async () => []),
  getEndpointFilterStats: vi.fn(async () => null),
  recordEndpointSuccess: vi.fn(async () => {}),
  recordEndpointFailure: vi.fn(async () => {}),
  isVendorTypeCircuitOpen: vi.fn(async () => false),
  recordVendorTypeAllEndpointsTimeout: vi.fn(async () => {}),
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
  getCircuitState: vi.fn(() => "closed"),
  getProviderHealthInfo: vi.fn(async () => ({
    health: { failureCount: 0 },
    config: { failureThreshold: 3 },
  })),
  pickRandomProviderWithExclusion: vi.fn(),
  updateMessageRequestDetails: vi.fn(async () => {}),
  categorizeErrorAsync: vi.fn(),
  getErrorDetectionResultAsync: vi.fn(async () => ({ matched: false })),
  applyFinal: vi.fn(async () => {}),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getCachedSystemSettings: mocks.getCachedSystemSettings,
    isHttp2Enabled: mocks.isHttp2Enabled,
  };
});

vi.mock("@/lib/provider-endpoints/endpoint-selector", () => ({
  getPreferredProviderEndpoints: mocks.getPreferredProviderEndpoints,
  getEndpointFilterStats: mocks.getEndpointFilterStats,
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointSuccess: mocks.recordEndpointSuccess,
  recordEndpointFailure: mocks.recordEndpointFailure,
}));

vi.mock("@/lib/circuit-breaker", () => ({
  getCircuitState: mocks.getCircuitState,
  getProviderHealthInfo: mocks.getProviderHealthInfo,
  recordFailure: mocks.recordFailure,
  recordSuccess: mocks.recordSuccess,
}));

vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: mocks.isVendorTypeCircuitOpen,
  recordVendorTypeAllEndpointsTimeout: mocks.recordVendorTypeAllEndpointsTimeout,
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateMessageRequestDetails,
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: {
    pickRandomProviderWithExclusion: mocks.pickRandomProviderWithExclusion,
  },
}));

vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    applyFinal: mocks.applyFinal,
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  mocks.categorizeErrorAsync.mockImplementation(async (error: unknown) =>
    error instanceof actual.ProxyError
      ? actual.ErrorCategory.PROVIDER_ERROR
      : actual.ErrorCategory.SYSTEM_ERROR
  );
  return {
    ...actual,
    categorizeErrorAsync: mocks.categorizeErrorAsync,
    getErrorDetectionResultAsync: mocks.getErrorDetectionResultAsync,
  };
});

import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ErrorCategory, ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

type ServerMode = "http_503" | "connection_reset" | "healthy";

type ProviderServer = {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
};

async function startProviderServer(mode: ServerMode): Promise<ProviderServer> {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests += 1;

    if (mode === "connection_reset") {
      req.resume();
      res.destroy();
      return;
    }

    const body =
      mode === "http_503"
        ? JSON.stringify({ error: { message: "synthetic provider outage" } })
        : JSON.stringify({
            type: "message",
            content: [{ type: "text", text: "healthy-provider" }],
          });
    const status = mode === "http_503" ? 503 : 200;

    res.writeHead(status, {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json; charset=utf-8",
    });
    res.end(body);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve local provider address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    url,
    requestCount: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function createProvider(id: number, url: string, name: string): Provider {
  return {
    id,
    name,
    url,
    key: `synthetic-key-${id}`,
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    disableSessionReuse: false,
    activeTimeStart: null,
    activeTimeEnd: null,
    modelRedirects: null,
    allowedModels: null,
    allowedClients: [],
    blockedClients: [],
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limit5hResetMode: "fixed",
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    recoverySettings: null,
    recoveryProbeBudgets: null,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    customHeaders: null,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 10_000,
    requestTimeoutNonStreamingMs: 1_000,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    swapCacheTtlBilling: false,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    codexServiceTierPreference: null,
    codexCompactionV2Capability: "unsupported",
    deepseekReasoningEffortPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createSession(): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://client.example.com/v1/messages"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "claude-test",
      log: "(test)",
      message: {
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      },
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    endpointPolicy: resolveEndpointPolicy("/v1/messages"),
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    providersSnapshot: [],
    isHeaderModified: () => false,
  });

  session.setRawCrossProviderFallbackEnabled(false);
  session.setRecoveryAuthorityMode("legacy");
  return session as ProxySession;
}

function expectFailoverChain(session: ProxySession, failedId: number, failedReason: string) {
  const chain = session.getProviderChain();
  expect(chain).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: failedId, reason: failedReason }),
      expect.objectContaining({ id: 2, reason: "retry_success", statusCode: 200 }),
    ])
  );
}

describe("ProxyForwarder real local provider failure failover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.categorizeErrorAsync.mockImplementation(async (error: unknown) =>
      error instanceof ProxyError ? ErrorCategory.PROVIDER_ERROR : ErrorCategory.SYSTEM_ERROR
    );
  });

  test("fails over after an actual upstream HTTP 503", async () => {
    const failedServer = await startProviderServer("http_503");
    const healthyServer = await startProviderServer("healthy");

    try {
      const failedProvider = createProvider(1, failedServer.url, "provider-a");
      const healthyProvider = createProvider(2, healthyServer.url, "provider-b");
      const session = createSession();
      session.setProvider(failedProvider);
      mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(healthyProvider);

      const response = await ProxyForwarder.send(session);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("healthy-provider");
      expect(failedServer.requestCount()).toBe(1);
      expect(healthyServer.requestCount()).toBe(1);
      expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledTimes(1);
      expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
      expectFailoverChain(session, 1, "retry_failed");
    } finally {
      await Promise.all([failedServer.close(), healthyServer.close()]);
    }
  });

  test("fails over after an actual upstream connection reset", async () => {
    const failedServer = await startProviderServer("connection_reset");
    const healthyServer = await startProviderServer("healthy");

    try {
      const failedProvider = createProvider(1, failedServer.url, "provider-a");
      const healthyProvider = createProvider(2, healthyServer.url, "provider-b");
      const session = createSession();
      session.setProvider(failedProvider);
      mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(healthyProvider);

      const response = await ProxyForwarder.send(session);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("healthy-provider");
      expect(failedServer.requestCount()).toBe(1);
      expect(healthyServer.requestCount()).toBe(1);
      expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledTimes(1);
      expect(mocks.pickRandomProviderWithExclusion).toHaveBeenCalledWith(session, [1]);
      expectFailoverChain(session, 1, "system_error");
    } finally {
      await Promise.all([failedServer.close(), healthyServer.close()]);
    }
  });
});
