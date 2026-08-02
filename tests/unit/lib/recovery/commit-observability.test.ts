import { describe, expect, it, vi } from "vitest";
import {
  commitBufferedMigrationResponse,
  commitStreamingMigrationResponse,
  containsCompleteSseEvent,
} from "@/lib/recovery/failback-commit";
import {
  notificationClassForState,
  notificationClassForTransition,
  RecoveryMetricRegistry,
  RECOVERY_METRIC_ATTRIBUTE_VALUES,
  RECOVERY_METRIC_CONTRACT,
  RecoveryNotificationDeduplicator,
  RecoveryNotificationDispatcher,
  recoveryTransitionLog,
} from "@/lib/recovery/observability";

describe("failback output boundary and observability", () => {
  it("commits a complete response before returning client-visible output", async () => {
    const order: string[] = [];
    const response = await commitBufferedMigrationResponse({
      upstream: new Response("complete"),
      validate: async () => {
        order.push("validated");
        return true;
      },
      committer: {
        commit: async () => {
          order.push("committed");
          return { code: "applied" };
        },
      },
    });
    order.push("returned");
    expect(await response.text()).toBe("complete");
    expect(order).toEqual(["validated", "committed", "returned"]);
  });

  it("does not expose streaming bytes before the first valid event and commit", async () => {
    const encoder = new TextEncoder();
    const order: string[] = [];
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"ok":true}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      })
    );
    const response = await commitStreamingMigrationResponse({
      upstream,
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: {
        commit: async () => {
          order.push("commit");
          return { code: "applied" };
        },
      },
    });
    order.push("response");
    expect(await response.text()).toContain("[DONE]");
    expect(order).toEqual(["commit", "response"]);
  });

  it("returns one 503 and no output when commit fails", async () => {
    const response = await commitBufferedMigrationResponse({
      upstream: new Response("target"),
      validate: () => true,
      committer: { commit: async () => ({ code: "stale_generation" }) },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.text()).not.toContain("target");
  });

  it("handles commit exceptions and incomplete or oversized streaming prefixes", async () => {
    const thrown = await commitBufferedMigrationResponse({
      upstream: new Response("complete"),
      validate: () => true,
      committer: { commit: async () => Promise.reject(new Error("redis unavailable")) },
    });
    expect(thrown.status).toBe(503);

    const missingBody = await commitStreamingMigrationResponse({
      upstream: new Response(null),
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: { commit: async () => ({ code: "applied" }) },
    });
    expect(missingBody.status).toBe(503);

    const incomplete = await commitStreamingMigrationResponse({
      upstream: new Response("data: incomplete"),
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: { commit: async () => ({ code: "applied" }) },
    });
    expect(incomplete.status).toBe(503);

    const oversized = await commitStreamingMigrationResponse({
      upstream: new Response("too many bytes"),
      isProtocolValidPrefix: () => false,
      maximumPrebufferBytes: 2,
      committer: { commit: async () => ({ code: "applied" }) },
    });
    expect(oversized.status).toBe(503);
  });

  it("streams the committed prefix and remaining chunks to completion", async () => {
    const encoder = new TextEncoder();
    let pull = 0;
    const upstream = new Response(
      new ReadableStream({
        pull(controller) {
          pull += 1;
          if (pull === 1) controller.enqueue(encoder.encode("data: first\n\n"));
          else if (pull === 2) controller.enqueue(encoder.encode("data: second\n\n"));
          else controller.close();
        },
      })
    );
    const response = await commitStreamingMigrationResponse({
      upstream,
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: { commit: async () => ({ code: "applied" }) },
    });
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
  });

  it("does not expose an invalid buffered target response or commit it", async () => {
    const commit = vi.fn(async () => ({ code: "applied" }));
    const response = await commitBufferedMigrationResponse({
      upstream: new Response("invalid target bytes"),
      validate: () => false,
      committer: { commit },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("target bytes");
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits once before output and never rolls back after a later stream truncation", async () => {
    const encoder = new TextEncoder();
    const commit = vi.fn(async () => ({ code: "applied" }));
    let pulls = 0;
    const upstream = new Response(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(encoder.encode('data: {"ok":true}\n\n'));
          else controller.error(new Error("truncated after commit"));
        },
      })
    );
    const response = await commitStreamingMigrationResponse({
      upstream,
      isProtocolValidPrefix: containsCompleteSseEvent,
      committer: { commit },
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ok");
    await expect(reader.read()).rejects.toThrow("truncated after commit");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("enforces metric cardinality and redacted transition contracts", async () => {
    const metrics = new RecoveryMetricRegistry();
    metrics.add("recovery.transitions", 1, {
      scope_kind: "provider",
      from_state: "closed",
      to_state: "open",
      reason_class: "transport",
    });
    expect(metrics.snapshot().size).toBe(1);
    expect(() => metrics.add("recovery.transitions", 1, { provider_id: "123" })).toThrow(
      "not allowed"
    );
    expect(() => metrics.add("recovery.unregistered", 1, {})).toThrow("undeclared");
    for (const [instrument, attributes] of Object.entries(RECOVERY_METRIC_CONTRACT)) {
      expect(() =>
        metrics.add(
          instrument,
          1,
          Object.fromEntries(
            attributes.map((attribute) => [
              attribute,
              RECOVERY_METRIC_ATTRIBUTE_VALUES[
                attribute as keyof typeof RECOVERY_METRIC_ATTRIBUTE_VALUES
              ][0],
            ])
          )
        )
      ).not.toThrow();
    }
    expect(
      recoveryTransitionLog({
        scope: { kind: "provider", providerId: 4 },
        from: "closed",
        to: "open",
        epoch: 2,
        reasonClass: "timeout",
      })
    ).not.toHaveProperty("providerId");
    const redis = { set: vi.fn(async () => "OK") };
    const dedupe = new RecoveryNotificationDeduplicator(redis);
    expect(await dedupe.shouldNotify({ scopeHash: "a".repeat(64), state: "open", epoch: 2 })).toBe(
      true
    );
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(":open:2"),
      "1",
      "EX",
      300,
      "NX"
    );
  });

  it("deduplicates bounded notification payloads without high-cardinality identifiers", async () => {
    const redis = { set: vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null) };
    const sink = vi.fn(async () => undefined);
    const dispatcher = new RecoveryNotificationDispatcher(
      new RecoveryNotificationDeduplicator(redis),
      sink
    );
    const input = {
      scope: { kind: "provider" as const, providerId: 42 },
      scopeHash: "b".repeat(64),
      state: "open" as const,
      epoch: 3,
      notificationClass: "opened" as const,
    };

    expect(await dispatcher.dispatch(input)).toBe(true);
    expect(await dispatcher.dispatch(input)).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual({
      notificationClass: "opened",
      scopeKind: "provider",
      state: "open",
      epoch: 3,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("42");
  });

  it("rejects undeclared cardinality and validates redacted notification inputs", async () => {
    const metrics = new RecoveryMetricRegistry();
    metrics.add("recovery.failback_skips", 1, { skip_reason: "stateless" });
    expect(() =>
      metrics.add("recovery.failback_skips", 1, { skip_reason: "provider-123" })
    ).toThrow("value is not allowed");
    expect(() =>
      metrics.add("recovery.failback_skips", 1, { skip_reason: "x".repeat(33) })
    ).toThrow("value is not allowed");
    expect(() =>
      recoveryTransitionLog({
        scope: { kind: "provider", providerId: 1 },
        from: "closed",
        to: "open",
        epoch: 1,
        reasonClass: "invalid reason",
      })
    ).toThrow("invalid reason class");
    const dedupe = new RecoveryNotificationDeduplicator({ set: vi.fn() });
    await expect(
      dedupe.shouldNotify({ scopeHash: "not-a-hash", state: "open", epoch: 1 })
    ).rejects.toThrow("invalid scope hash");
  });

  it("maps every state and special transition to a bounded notification class", () => {
    expect(notificationClassForState("open", false)).toBe("opened");
    expect(notificationClassForState("probing", false)).toBe("opened");
    expect(notificationClassForState("half_open", false)).toBe("half_open");
    expect(notificationClassForState("recovering", false)).toBe("recovering");
    expect(notificationClassForState("closed", false)).toBe("recovered");
    expect(notificationClassForState("closed", true)).toBe("paused");
    expect(
      notificationClassForTransition({
        from: "closed",
        to: "open",
        automationPaused: false,
        reasonClass: "admin_pause",
      })
    ).toBe("administrator_forced");
    expect(
      notificationClassForTransition({
        from: "recovering",
        to: "open",
        automationPaused: false,
        reasonClass: "timeout",
      })
    ).toBe("reopened");
    expect(
      notificationClassForTransition({
        from: "half_open",
        to: "recovering",
        automationPaused: false,
        reasonClass: "healthy",
      })
    ).toBe("recovering");
  });
});
