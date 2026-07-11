import { describe, expect, test } from "vitest";
import {
  isResponsesCompactionV2Request,
  providerSupportsResponsesCompactionV2,
  processResponsesCompactionV2Stream,
} from "./responses-compaction-v2";

const encoder = new TextEncoder();

function stream(parts: string[], failure?: Error): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(encoder.encode(parts[index++]));
        return;
      }
      if (failure) controller.error(failure);
      else controller.close();
    },
  });
}

async function read(source: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(source).text();
}

describe("Responses compaction v2", () => {
  test("detects only a top-level input trigger on the exact endpoint", () => {
    expect(
      isResponsesCompactionV2Request("/v1/responses", { input: [{ type: "compaction_trigger" }] })
    ).toBe(true);
    expect(
      isResponsesCompactionV2Request("/v1/responses/compact", {
        input: [{ type: "compaction_trigger" }],
      })
    ).toBe(false);
    expect(
      isResponsesCompactionV2Request("/v1/responses", {
        input: [{ nested: { type: "compaction_trigger" } }],
      })
    ).toBe(false);
    expect(isResponsesCompactionV2Request("/v1/responses", { input: ["compaction_trigger"] })).toBe(
      false
    );
  });

  test("excludes unsupported providers from v2 routing", () => {
    expect(
      providerSupportsResponsesCompactionV2({
        providerType: "codex",
        codexCompactionV2Capability: "unsupported",
      } as never)
    ).toBe(false);
    expect(
      providerSupportsResponsesCompactionV2({
        providerType: "codex",
        codexCompactionV2Capability: "legacy_adapter",
      } as never)
    ).toBe(true);
  });

  test("passes native v2 events through byte-for-byte", async () => {
    const input =
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"cipher"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2}}}\n\n';
    expect(await read(processResponsesCompactionV2Stream(stream([input]), "native_v2"))).toBe(
      input
    );
  });

  test("adapts legacy items across chunk boundaries and terminal output", async () => {
    const input =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"compaction_summary","encrypted_content":"cipher","extra":1}}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"compaction_summary","encrypted_content":"cipher","extra":1}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[{"type":"compaction_summary","encrypted_content":"cipher"}],"usage":{"input_tokens":2}}}\n\n';
    const output = await read(
      processResponsesCompactionV2Stream(
        stream([input.slice(0, 37), input.slice(37)]),
        "legacy_adapter"
      )
    );
    expect(output).not.toContain("compaction_summary");
    expect(output).toContain('"type":"compaction"');
    expect(output).toContain('"extra":1');
    expect(output).toContain('"usage":{"input_tokens":2}');
  });

  test.each([
    ["zero", 'data: {"type":"response.completed","response":{"output":[]}}\n\n'],
    [
      "missing ciphertext",
      'data: {"type":"response.output_item.done","item":{"type":"compaction_summary"}}\n\ndata: {"type":"response.completed","response":{}}\n\n',
    ],
    [
      "multiple",
      'data: {"type":"response.output_item.done","item":{"type":"compaction_summary","encrypted_content":"a"}}\n\ndata: {"type":"response.output_item.done","item":{"type":"compaction_summary","encrypted_content":"b"}}\n\ndata: {"type":"response.completed","response":{}}\n\n',
    ],
  ])("rejects %s legacy results", async (_name, input) => {
    await expect(
      read(processResponsesCompactionV2Stream(stream([input]), "legacy_adapter"))
    ).rejects.toThrow("expected exactly one");
  });

  test("does not treat failed or incomplete as a successful terminal", async () => {
    for (const type of ["response.failed", "response.incomplete"]) {
      const input = `data: {"type":"response.output_item.done","item":{"type":"compaction_summary","encrypted_content":"a"}}\n\ndata: {"type":"${type}","response":{}}\n\n`;
      await expect(
        read(processResponsesCompactionV2Stream(stream([input]), "legacy_adapter"))
      ).rejects.toThrow();
    }
  });

  test("swallows expected reset only after a complete successful terminal", async () => {
    const completed = 'data: {"type":"response.completed","response":{}}\n\n';
    const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    expect(
      await read(processResponsesCompactionV2Stream(stream([completed], reset), "native_v2"))
    ).toBe(completed);
    await expect(
      read(processResponsesCompactionV2Stream(stream(["data: {}\n\n"], reset), "native_v2"))
    ).rejects.toThrow("socket reset");
  });

  test("legacy encrypted output can be replayed without changing the ciphertext", async () => {
    const input =
      'data: {"type":"response.output_item.done","item":{"type":"compaction_summary","encrypted_content":"opaque-provider-token"}}\n\ndata: {"type":"response.completed","response":{}}\n\n';
    const output = await read(
      processResponsesCompactionV2Stream(stream([input]), "legacy_adapter")
    );
    const done = output.split("\n").find((line) => line.includes("response.output_item.done"));
    const item = JSON.parse(done!.slice(6)).item;
    expect(item).toEqual({ type: "compaction", encrypted_content: "opaque-provider-token" });
    expect(
      { input: [item, { role: "user", content: "continue" }] }.input[0].encrypted_content
    ).toBe("opaque-provider-token");
  });
});
