import type { CodexCompactionV2Capability, Provider } from "@/types/provider";

export function isResponsesCompactionV2Request(
  pathname: string,
  message: Record<string, unknown>
): boolean {
  if (pathname !== "/v1/responses" || !Array.isArray(message.input)) return false;
  return message.input.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "compaction_trigger"
  );
}

export function hasProviderBoundCompactionState(
  pathname: string,
  message: Record<string, unknown>
): boolean {
  if (pathname !== "/v1/responses" || !Array.isArray(message.input)) return false;
  return message.input.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "compaction" &&
      typeof (item as Record<string, unknown>).encrypted_content === "string" &&
      ((item as Record<string, unknown>).encrypted_content as string).length > 0
  );
}

export function providerSupportsResponsesCompactionV2(provider: Provider): boolean {
  return (
    provider.providerType === "codex" && provider.codexCompactionV2Capability !== "unsupported"
  );
}

function isExpectedPostTerminalError(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  const code = value?.code ?? "";
  const message = value?.message?.toLowerCase() ?? "";
  return (
    ["ECONNRESET", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE", "INTERNAL_ERROR"].includes(
      code
    ) ||
    message.includes("premature close") ||
    message.includes("http/2 stream") ||
    message.includes("internal_error")
  );
}

function adaptItem(item: unknown): {
  value: unknown;
  compaction: boolean;
  legacy: boolean;
  valid: boolean;
} {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { value: item, compaction: false, legacy: false, valid: false };
  }
  const record = item as Record<string, unknown>;
  if (record.type !== "compaction" && record.type !== "compaction_summary") {
    return { value: item, compaction: false, legacy: false, valid: false };
  }
  const valid = typeof record.encrypted_content === "string" && record.encrypted_content.length > 0;
  const legacy = record.type === "compaction_summary";
  return {
    value: legacy && valid ? { ...record, type: "compaction" } : item,
    compaction: true,
    legacy,
    valid,
  };
}

function adaptPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  changed: boolean;
  doneCompactions: number;
  invalidCompactions: number;
} {
  let doneCompactions = 0;
  let invalidCompactions = 0;
  let changed = false;
  let next = payload;

  if (
    payload.type === "response.output_item.added" ||
    payload.type === "response.output_item.done"
  ) {
    const adapted = adaptItem(payload.item);
    if (adapted.legacy && adapted.valid) {
      next = { ...next, item: adapted.value };
      changed = true;
    }
    if (payload.type === "response.output_item.done" && adapted.compaction) {
      doneCompactions += 1;
      if (!adapted.valid) invalidCompactions += 1;
    }
  }

  if (
    payload.type === "response.completed" &&
    typeof payload.response === "object" &&
    payload.response
  ) {
    const response = payload.response as Record<string, unknown>;
    if (Array.isArray(response.output)) {
      const output = response.output.map((item) => {
        const adapted = adaptItem(item);
        if (adapted.legacy && adapted.valid) changed = true;
        return adapted.value;
      });
      if (changed) next = { ...next, response: { ...response, output } };
    }
  }
  return { payload: next, changed, doneCompactions, invalidCompactions };
}

function transformSseBlock(
  block: string,
  legacyAdapter: boolean
): { text: string; type?: string; doneCompactions: number; invalidCompactions: number } {
  const lines = block.split(/\r?\n/);
  let type: string | undefined;
  let doneCompactions = 0;
  let invalidCompactions = 0;
  const output = lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const raw = line.slice(5).trimStart();
    if (!raw || raw === "[DONE]") return line;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid compaction v2 response: malformed SSE JSON");
    }

    type = typeof parsed.type === "string" ? parsed.type : type;
    if (!legacyAdapter) return line;
    const adapted = adaptPayload(parsed);
    doneCompactions += adapted.doneCompactions;
    invalidCompactions += adapted.invalidCompactions;
    return adapted.changed ? `data: ${JSON.stringify(adapted.payload)}` : line;
  });
  return { text: `${output.join("\n")}\n\n`, type, doneCompactions, invalidCompactions };
}

function assertValidLegacyCompaction(doneCompactions: number, invalidCompactions: number): void {
  if (doneCompactions !== 1 || invalidCompactions !== 0) {
    throw new Error(
      `Invalid compaction v2 response: expected exactly one encrypted compaction item, received ${doneCompactions}`
    );
  }
}

export function processResponsesCompactionV2Stream(
  source: ReadableStream<Uint8Array>,
  capability: CodexCompactionV2Capability
): ReadableStream<Uint8Array> {
  if (capability !== "legacy_adapter") return terminalAwarePassthrough(source);

  const reader = source.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let pending = "";
        let successfulTerminal = false;
        let doneCompactions = 0;
        let invalidCompactions = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            pending = pending.replace(/\r\n/g, "\n");
            let boundary = pending.indexOf("\n\n");
            while (boundary >= 0) {
              const event = transformSseBlock(pending.slice(0, boundary), true);
              pending = pending.slice(boundary + 2);
              doneCompactions += event.doneCompactions;
              invalidCompactions += event.invalidCompactions;
              if (event.type === "response.completed") {
                assertValidLegacyCompaction(doneCompactions, invalidCompactions);
                successfulTerminal = true;
              }
              controller.enqueue(encoder.encode(event.text));
              boundary = pending.indexOf("\n\n");
            }
          }
          pending += decoder.decode();
          if (pending.trim()) {
            const event = transformSseBlock(pending, true);
            doneCompactions += event.doneCompactions;
            invalidCompactions += event.invalidCompactions;
            if (event.type === "response.completed") {
              assertValidLegacyCompaction(doneCompactions, invalidCompactions);
              successfulTerminal = true;
            }
            controller.enqueue(encoder.encode(event.text));
          }
        } catch (error) {
          if (cancelled) return;
          if (!(successfulTerminal && isExpectedPostTerminalError(error))) {
            controller.error(error);
            return;
          }
        }

        if (!successfulTerminal) {
          controller.error(new Error("Invalid compaction v2 response: missing response.completed"));
          return;
        }
        controller.close();
      })();
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } catch {
        // The downstream is already cancelled; source cancellation is best effort.
      }
    },
  });
}

function terminalAwarePassthrough(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const decoder = new TextDecoder();
        let pending = "";
        let successfulTerminal = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
            let boundary = pending.indexOf("\n\n");
            while (boundary >= 0) {
              try {
                const event = transformSseBlock(pending.slice(0, boundary), false);
                if (event.type === "response.completed") successfulTerminal = true;
              } catch {
                // Native mode preserves upstream bytes even when a frame is not JSON.
              }
              pending = pending.slice(boundary + 2);
              boundary = pending.indexOf("\n\n");
            }
          }
        } catch (error) {
          if (cancelled) return;
          if (!(successfulTerminal && isExpectedPostTerminalError(error))) {
            controller.error(error);
            return;
          }
        }
        controller.close();
      })();
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } catch {
        // The downstream is already cancelled; source cancellation is best effort.
      }
    },
  });
}

export function processResponsesCompactionV2Response(
  response: Response,
  capability: CodexCompactionV2Capability
): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  return new Response(processResponsesCompactionV2Stream(response.body, capability), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
