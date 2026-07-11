import type { Provider } from "@/types/provider";

export type CodexCompactionV2Capability = "native_v2" | "legacy_adapter" | "unsupported";

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

function adaptItem(item: unknown): { value: unknown; legacy: boolean; valid: boolean } {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { value: item, legacy: false, valid: false };
  }
  const record = item as Record<string, unknown>;
  if (record.type !== "compaction_summary") {
    return { value: item, legacy: false, valid: record.type === "compaction" };
  }
  const valid = typeof record.encrypted_content === "string" && record.encrypted_content.length > 0;
  return { value: valid ? { ...record, type: "compaction" } : item, legacy: true, valid };
}

function adaptPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  doneCompactions: number;
  invalidCompactions: number;
} {
  let doneCompactions = 0;
  let invalidCompactions = 0;
  let next = payload;

  if (
    payload.type === "response.output_item.added" ||
    payload.type === "response.output_item.done"
  ) {
    const adapted = adaptItem(payload.item);
    if (adapted.legacy) next = { ...next, item: adapted.value };
    if (payload.type === "response.output_item.done" && adapted.legacy) {
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
      next = {
        ...next,
        response: { ...response, output: response.output.map((item) => adaptItem(item).value) },
      };
    }
  }
  return { payload: next, doneCompactions, invalidCompactions };
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
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      type = typeof parsed.type === "string" ? parsed.type : type;
      if (!legacyAdapter) return line;
      const adapted = adaptPayload(parsed);
      doneCompactions += adapted.doneCompactions;
      invalidCompactions += adapted.invalidCompactions;
      return `data: ${JSON.stringify(adapted.payload)}`;
    } catch {
      return line;
    }
  });
  return { text: `${output.join("\n")}\n\n`, type, doneCompactions, invalidCompactions };
}

export function processResponsesCompactionV2Stream(
  source: ReadableStream<Uint8Array>,
  capability: CodexCompactionV2Capability
): ReadableStream<Uint8Array> {
  const legacyAdapter = capability === "legacy_adapter";
  if (!legacyAdapter) {
    return terminalAwarePassthrough(source);
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let pending = "";
      let successfulTerminal = false;
      let doneCompactions = 0;
      let invalidCompactions = 0;
      const buffered: string[] = [];
      const emit = (text: string) =>
        legacyAdapter ? buffered.push(text) : controller.enqueue(encoder.encode(text));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          pending = pending.replace(/\r\n/g, "\n");
          let boundary = pending.indexOf("\n\n");
          while (boundary >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const event = transformSseBlock(block, legacyAdapter);
            doneCompactions += event.doneCompactions;
            invalidCompactions += event.invalidCompactions;
            if (event.type === "response.completed") successfulTerminal = true;
            emit(event.text);
            boundary = pending.indexOf("\n\n");
          }
        }
        pending += decoder.decode();
        if (pending.trim()) {
          const event = transformSseBlock(pending, legacyAdapter);
          doneCompactions += event.doneCompactions;
          invalidCompactions += event.invalidCompactions;
          if (event.type === "response.completed") successfulTerminal = true;
          emit(event.text);
        }
      } catch (error) {
        if (!(successfulTerminal && isExpectedPostTerminalError(error))) {
          controller.error(error);
          return;
        }
      }

      if (legacyAdapter) {
        if (!successfulTerminal || doneCompactions !== 1 || invalidCompactions !== 0) {
          controller.error(
            new Error(
              `Invalid compaction v2 response: expected exactly one encrypted compaction item, received ${doneCompactions}`
            )
          );
          return;
        }
        for (const text of buffered) controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
}

function terminalAwarePassthrough(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
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
            const event = transformSseBlock(pending.slice(0, boundary), false);
            if (event.type === "response.completed") successfulTerminal = true;
            pending = pending.slice(boundary + 2);
            boundary = pending.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!(successfulTerminal && isExpectedPostTerminalError(error))) {
          controller.error(error);
          return;
        }
      }
      controller.close();
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
