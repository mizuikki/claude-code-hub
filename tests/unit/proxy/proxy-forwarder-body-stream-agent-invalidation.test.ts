/**
 * Post-header body stream transport failures should invalidate pooled agents.
 */
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const undiciMocks = vi.hoisted(() => ({
  Agent: vi.fn(),
  ProxyAgent: vi.fn(),
  setGlobalDispatcher: vi.fn(),
  request: vi.fn(),
  fetch: vi.fn(),
}));

const agentPoolMocks = vi.hoisted(() => ({
  markUnhealthy: vi.fn(),
  releaseAgent: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("undici", () => undiciMocks);

vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => agentPoolMocks),
}));

type PooledAgentArg = {
  cacheKey: string | null;
  dispatcherId: string | null;
  connectionType: "proxy" | "direct";
};

type FetchWithoutAutoDecode = (
  url: string,
  init: RequestInit,
  providerId: number,
  providerName: string,
  session?: {
    clientAbortSignal?: AbortSignal;
    shouldPersistSessionDebugArtifacts?: () => boolean;
    sessionId?: string | null;
  },
  deferDetailSnapshotPersistence?: boolean,
  pooledAgent?: PooledAgentArg | null
) => Promise<Response>;

function createFailingBody(error: Error): Readable {
  let failed = false;
  return new Readable({
    read() {
      if (failed) return;
      failed = true;
      // Fail during first pull so headers are already returned by undici.request.
      this.destroy(error);
    },
  });
}

async function loadFetchWithoutAutoDecode(): Promise<FetchWithoutAutoDecode> {
  const { ProxyForwarder } = await import("@/app/v1/_lib/proxy/forwarder");
  return (
    ProxyForwarder as unknown as {
      fetchWithoutAutoDecode: FetchWithoutAutoDecode;
    }
  ).fetchWithoutAutoDecode;
}

async function drainRejectedBody(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // expected stream failure
  }
}

/** Short bounded settle window for negative assertions only. */
async function settleBriefly(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ProxyForwarder body stream agent invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("marks pooled agent unhealthy when body stream fails with ECONNRESET after headers", async () => {
    const streamError = new Error("read ECONNRESET") as NodeJS.ErrnoException;
    streamError.code = "ECONNRESET";

    undiciMocks.request.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: createFailingBody(streamError),
    });

    const fetchWithoutAutoDecode = await loadFetchWithoutAutoDecode();
    const response = await fetchWithoutAutoDecode(
      "https://example.com/v1/responses",
      { method: "POST" },
      38,
      "packyapi_grok-direct",
      {
        shouldPersistSessionDebugArtifacts: () => false,
        sessionId: null,
      },
      false,
      {
        cacheKey: "direct:example.com",
        dispatcherId: "dispatcher-1",
        connectionType: "direct",
      }
    );

    expect(response.status).toBe(200);
    await drainRejectedBody(response);

    await vi.waitFor(
      () => {
        expect(agentPoolMocks.markUnhealthy).toHaveBeenCalledWith(
          "direct:example.com",
          expect.stringContaining("ECONNRESET"),
          "dispatcher-1"
        );
      },
      { timeout: 2000, interval: 10 }
    );
  });

  it("does not mark pooled agent unhealthy for client abort disconnects", async () => {
    // Even if the surface code is ECONNRESET, client abort must not poison the pool.
    const streamError = new Error("read ECONNRESET") as NodeJS.ErrnoException;
    streamError.code = "ECONNRESET";

    undiciMocks.request.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: createFailingBody(streamError),
    });

    const controller = new AbortController();
    controller.abort();

    const fetchWithoutAutoDecode = await loadFetchWithoutAutoDecode();
    const response = await fetchWithoutAutoDecode(
      "https://example.com/v1/responses",
      { method: "POST" },
      26,
      "input",
      {
        clientAbortSignal: controller.signal,
        shouldPersistSessionDebugArtifacts: () => false,
        sessionId: null,
      },
      false,
      {
        cacheKey: "direct:example.com",
        dispatcherId: "dispatcher-2",
        connectionType: "direct",
      }
    );

    expect(response.status).toBe(200);
    await drainRejectedBody(response);
    await settleBriefly();

    expect(agentPoolMocks.markUnhealthy).not.toHaveBeenCalled();
  });

  it("does not mark pooled agent unhealthy for generic non-transport body errors", async () => {
    const genericError = new Error("application boom");

    undiciMocks.request.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: createFailingBody(genericError),
    });

    const fetchWithoutAutoDecode = await loadFetchWithoutAutoDecode();
    const response = await fetchWithoutAutoDecode(
      "https://example.com/v1/responses",
      { method: "POST" },
      1,
      "test-provider",
      {
        shouldPersistSessionDebugArtifacts: () => false,
        sessionId: null,
      },
      false,
      {
        cacheKey: "direct:example.com",
        dispatcherId: "dispatcher-3",
        connectionType: "direct",
      }
    );

    expect(response.status).toBe(200);
    await drainRejectedBody(response);
    await settleBriefly();

    expect(agentPoolMocks.markUnhealthy).not.toHaveBeenCalled();
  });
});
