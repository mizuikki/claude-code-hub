import { describe, expect, test } from "vitest";
import { KeyAdminCreateSchema, KeyCreateSchema } from "@/lib/api/v1/schemas/keys";
import {
  ProviderCreateSchema,
  ProviderSummarySchema,
  ProviderUpdateSchema as ProviderApiUpdateSchema,
} from "@/lib/api/v1/schemas/providers";
import {
  buildProviderBatchApplyUpdates,
  normalizeProviderBatchPatchDraft,
} from "@/lib/provider-patch-contract";
import { CreateProviderSchema, UpdateProviderSchema } from "@/lib/validation/schemas";
import { toProvider } from "@/repository/_shared/transformers";

const MINIMAL_PROVIDER = {
  name: "codex",
  url: "https://example.com/v1",
  key: "secret",
  provider_type: "codex",
};

describe("provider compaction v2 contracts", () => {
  test("defaults provider creation to legacy_adapter", () => {
    expect(CreateProviderSchema.parse(MINIMAL_PROVIDER).codex_compaction_v2_capability).toBe(
      "legacy_adapter"
    );
  });

  test.each(["native_v2", "legacy_adapter", "unsupported"] as const)(
    "accepts %s through action and REST write schemas",
    (capability) => {
      const input = { ...MINIMAL_PROVIDER, codex_compaction_v2_capability: capability };
      expect(CreateProviderSchema.parse(input).codex_compaction_v2_capability).toBe(capability);
      expect(UpdateProviderSchema.parse({ codex_compaction_v2_capability: capability })).toEqual({
        codex_compaction_v2_capability: capability,
      });
      expect(ProviderCreateSchema.parse(input).codex_compaction_v2_capability).toBe(capability);
      expect(
        ProviderApiUpdateSchema.parse({ codex_compaction_v2_capability: capability })
          .codex_compaction_v2_capability
      ).toBe(capability);
    }
  );

  test("rejects unknown capability values", () => {
    expect(
      CreateProviderSchema.safeParse({
        ...MINIMAL_PROVIDER,
        codex_compaction_v2_capability: "automatic",
      }).success
    ).toBe(false);
    expect(
      ProviderApiUpdateSchema.safeParse({ codex_compaction_v2_capability: "automatic" }).success
    ).toBe(false);
  });

  test("round-trips the camelCase response shape", () => {
    const result = ProviderSummarySchema.safeParse({ codexCompactionV2Capability: "native_v2" });
    expect(result.success).toBe(false);
    expect(ProviderSummarySchema.shape.codexCompactionV2Capability.parse("native_v2")).toBe(
      "native_v2"
    );
  });

  test("transforms stored and pre-migration provider rows", () => {
    expect(
      toProvider({ codexCompactionV2Capability: "unsupported" }).codexCompactionV2Capability
    ).toBe("unsupported");
    expect(toProvider({}).codexCompactionV2Capability).toBe("legacy_adapter");
  });

  test("normalizes and applies batch capability patches", () => {
    const patch = normalizeProviderBatchPatchDraft({
      codex_compaction_v2_capability: { set: "unsupported" },
    });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    const updates = buildProviderBatchApplyUpdates(patch.data);
    expect(updates).toEqual({
      ok: true,
      data: { codex_compaction_v2_capability: "unsupported" },
    });
  });

  test("keeps exact-key import admin-only at the request schema boundary", () => {
    const payload = { name: "imported", key: "existing-user-key" };
    expect(KeyAdminCreateSchema.parse(payload).key).toBe("existing-user-key");
    expect(KeyCreateSchema.safeParse(payload).success).toBe(false);
  });
});
