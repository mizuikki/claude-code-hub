import { describe, expect, it } from "vitest";
import {
  listKnownEndpointFamilies,
  resolveEndpointFamilyByPath,
} from "@/app/v1/_lib/proxy/endpoint-family-catalog";
import {
  resolveEndpointPolicy,
  tightenEndpointRecoveryPolicy,
} from "@/app/v1/_lib/proxy/endpoint-policy";
import { STANDARD_ENDPOINT_PATHS } from "@/app/v1/_lib/proxy/endpoint-paths";

const ENDPOINT_FAMILY_POLICY_FIXTURES = [
  ["claude-messages", "/v1/messages"],
  ["claude-count-tokens", "/v1/messages/count_tokens"],
  ["response-execution", "/v1/responses"],
  ["response-resources", "/v1/responses/resp_123/input_items"],
  ["response-compact", "/v1/responses/compact"],
  ["openai-chat-completions", "/v1/chat/completions"],
  ["openai-chat-completions-resources", "/v1/chat/completions/id/messages"],
  ["openai-completions", "/v1/completions"],
  ["openai-embeddings", "/v1/embeddings"],
  ["openai-moderations", "/v1/moderations"],
  ["openai-audio-generation", "/v1/audio/speech"],
  ["openai-audio-transcription", "/v1/audio/transcriptions"],
  ["openai-audio-resources", "/v1/audio/voices"],
  ["openai-images", "/v1/images/generations"],
  ["openai-files", "/v1/files/id/content"],
  ["openai-uploads", "/v1/uploads/id/complete"],
  ["openai-batches", "/v1/batches/id/cancel"],
  ["openai-models", "/v1/models/gpt-4o"],
  ["openai-fine-tuning", "/v1/fine_tuning/jobs/id/events"],
  ["openai-evals", "/v1/evals/id/runs"],
  ["openai-assistants", "/v1/assistants/id"],
  ["openai-threads", "/v1/threads/id/runs"],
  ["openai-conversations", "/v1/conversations/id/items"],
  ["openai-vector-stores", "/v1/vector_stores/id/search"],
  ["openai-containers", "/v1/containers/id/files"],
  ["openai-realtime-http", "/v1/realtime/sessions"],
  ["openai-videos", "/v1/videos/edits"],
  ["openai-skills", "/v1/skills/id/content"],
  ["openai-chatkit", "/v1/chatkit/threads/id/items"],
  ["gemini-generate-content", "/v1beta/models/gemini:generateContent"],
  ["gemini-stream-generate-content", "/v1beta/models/gemini:streamGenerateContent"],
  ["gemini-count-tokens", "/v1beta/models/gemini:countTokens"],
  ["gemini-embed-content", "/v1beta/models/gemini:embedContent"],
  ["gemini-batch-generate-content", "/v1beta/models/gemini:batchGenerateContent"],
  ["gemini-batch-embed-contents", "/v1beta/models/gemini:batchEmbedContents"],
  ["gemini-async-batch-embed-content", "/v1beta/models/gemini:asyncBatchEmbedContent"],
  ["gemini-predict", "/v1beta/models/imagen:predict"],
  ["gemini-predict-long-running", "/v1beta/models/veo:predictLongRunning"],
  ["gemini-files", "/v1beta/files/id"],
  ["gemini-models-resource", "/v1beta/models/gemini"],
  ["gemini-cli-generate-content", "/v1internal/models/gemini:generateContent"],
  ["gemini-cli-stream-generate-content", "/v1internal/models/gemini:streamGenerateContent"],
] as const;

describe("endpoint recovery policy", () => {
  it("has an explicit policy fixture for every endpoint family", () => {
    expect(new Set(ENDPOINT_FAMILY_POLICY_FIXTURES.map(([id]) => id))).toEqual(
      new Set(listKnownEndpointFamilies().map((family) => family.id))
    );
    for (const [id, path] of ENDPOINT_FAMILY_POLICY_FIXTURES) {
      expect(resolveEndpointFamilyByPath(path)?.id).toBe(id);
      const policy = resolveEndpointPolicy(path);
      expect(policy).toEqual(
        expect.objectContaining({
          recoveryEvidence: expect.stringMatching(/^(none|connectivity|business)$/),
          halfOpenEligible: expect.any(Boolean),
          retrySafety: expect.stringMatching(/^(pre_commit_only|idempotent|never)$/),
          migrationSafety: expect.stringMatching(/^(replayable|provider_bound|unknown)$/),
          trackSessionBinding: expect.any(Boolean),
        })
      );
    }
  });

  it.each(STANDARD_ENDPOINT_PATHS)("has an explicit policy for %s", (path) => {
    const policy = resolveEndpointPolicy(path);
    expect(policy.recoveryEvidence).toMatch(/^(none|connectivity|business)$/);
    expect(policy.retrySafety).toMatch(/^(pre_commit_only|idempotent|never)$/);
    expect(policy.migrationSafety).toMatch(/^(replayable|provider_bound|unknown)$/);
  });

  it("keeps raw and unknown endpoint families conservative", () => {
    expect(resolveEndpointPolicy("/v1/files")).toMatchObject({
      recoveryEvidence: "none",
      halfOpenEligible: false,
      retrySafety: "never",
      migrationSafety: "provider_bound",
      trackSessionBinding: false,
    });
    expect(resolveEndpointPolicy("/v1/responses/compact")).toMatchObject({
      migrationSafety: "provider_bound",
    });
  });

  it("only tightens request-derived migration policy", () => {
    const base = resolveEndpointPolicy("/v1/responses");
    expect(
      tightenEndpointRecoveryPolicy(base, { body: { input: [] }, transport: "http" })
        .migrationSafety
    ).toBe("replayable");
    expect(
      tightenEndpointRecoveryPolicy(base, {
        body: { previous_response_id: "response" },
        transport: "http",
      })
    ).toMatchObject({
      migrationSafety: "provider_bound",
      retrySafety: "never",
      halfOpenEligible: false,
    });
    expect(
      tightenEndpointRecoveryPolicy(base, { body: {}, transport: "websocket" }).migrationSafety
    ).toBe("provider_bound");
  });
});
