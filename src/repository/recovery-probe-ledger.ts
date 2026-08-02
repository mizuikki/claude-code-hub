"use server";

import { eq, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { recoveryProbeLedger } from "@/drizzle/schema";
import type { RecoveryScope } from "@/lib/recovery/contracts";
import { hashRecoveryScope } from "@/lib/recovery/scope";

function providerIdFromScope(scope: RecoveryScope): number | null {
  return scope.kind === "vendor-type" ? null : scope.providerId;
}

export async function recordRecoveryProbeUsage(input: {
  readonly scope: RecoveryScope;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly succeeded: boolean;
  readonly durationMs: number;
}): Promise<boolean> {
  const providerId = providerIdFromScope(input.scope);
  if (providerId === null) return false;
  await db.insert(recoveryProbeLedger).values({
    providerId,
    scopeHash: hashRecoveryScope(input.scope),
    model: input.model.slice(0, 128),
    inputTokens: Math.max(0, Math.trunc(input.inputTokens)),
    outputTokens: Math.max(0, Math.trunc(input.outputTokens)),
    costUsd: input.costUsd === null ? null : String(Math.max(0, input.costUsd)),
    costUnknown: input.costUsd === null,
    succeeded: input.succeeded,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
  });
  return true;
}

export async function getRecoveryProbeProviderCost(providerId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${recoveryProbeLedger.costUsd}), 0)` })
    .from(recoveryProbeLedger)
    .where(eq(recoveryProbeLedger.providerId, providerId));
  return Number(row?.total ?? 0);
}
