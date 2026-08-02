"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { degradedRecoveryEvidence, keys, providers, systemSettings } from "@/drizzle/schema";
import {
  RecoveryProbeBudgetOverridesSchema,
  RecoverySettingsOverridesSchema,
  SessionFailbackSettingsOverridesSchema,
} from "@/lib/recovery/config";
import type {
  RecoveryAuthorityMode,
  RecoveryProbeBudgetOverrides,
  RecoveryScope,
  RecoverySettingsOverrides,
  SessionBindingAuthorityMode,
  SessionFailbackMode,
  SessionFailbackSettingsOverrides,
} from "@/lib/recovery/contracts";
import { hashRecoveryScope } from "@/lib/recovery/scope";
import { getSystemSettings } from "./system-config";

export interface PersistedSystemRecoveryConfig {
  readonly recoveryAuthorityMode: RecoveryAuthorityMode | null;
  readonly sessionBindingAuthorityMode: SessionBindingAuthorityMode | null;
  readonly recoverySettings: RecoverySettingsOverrides | null;
  readonly recoveryProbeBudgets: RecoveryProbeBudgetOverrides | null;
  readonly sessionFailbackSettings: SessionFailbackSettingsOverrides | null;
}

export interface PersistedProviderRecoveryConfig {
  readonly providerId: number;
  readonly recoverySettings: RecoverySettingsOverrides | null;
  readonly recoveryProbeBudgets: RecoveryProbeBudgetOverrides | null;
}

export interface PersistedRecoveryConfiguration {
  readonly system: PersistedSystemRecoveryConfig;
  readonly provider: PersistedProviderRecoveryConfig | null;
}

export async function getPersistedRecoveryConfiguration(
  providerId?: number
): Promise<PersistedRecoveryConfiguration> {
  const [systemRows, providerRows] = await Promise.all([
    db
      .select({
        recoveryAuthorityMode: systemSettings.recoveryAuthorityMode,
        sessionBindingAuthorityMode: systemSettings.sessionBindingAuthorityMode,
        recoverySettings: systemSettings.recoverySettings,
        recoveryProbeBudgets: systemSettings.recoveryProbeBudgets,
        sessionFailbackSettings: systemSettings.sessionFailbackSettings,
      })
      .from(systemSettings)
      .limit(1),
    providerId === undefined
      ? Promise.resolve([])
      : db
          .select({
            providerId: providers.id,
            recoverySettings: providers.recoverySettings,
            recoveryProbeBudgets: providers.recoveryProbeBudgets,
          })
          .from(providers)
          .where(and(eq(providers.id, providerId), isNull(providers.deletedAt)))
          .limit(1),
  ]);

  const system = systemRows[0];
  return {
    system: {
      recoveryAuthorityMode: system?.recoveryAuthorityMode ?? null,
      sessionBindingAuthorityMode: system?.sessionBindingAuthorityMode ?? null,
      recoverySettings: system?.recoverySettings ?? null,
      recoveryProbeBudgets: system?.recoveryProbeBudgets ?? null,
      sessionFailbackSettings: system?.sessionFailbackSettings ?? null,
    },
    provider: providerRows[0] ?? null,
  };
}

export async function updateSystemRecoveryConfiguration(
  updates: Partial<PersistedSystemRecoveryConfig>
): Promise<PersistedSystemRecoveryConfig> {
  if (updates.recoverySettings !== undefined && updates.recoverySettings !== null) {
    RecoverySettingsOverridesSchema.parse(updates.recoverySettings);
  }
  if (updates.recoveryProbeBudgets !== undefined && updates.recoveryProbeBudgets !== null) {
    RecoveryProbeBudgetOverridesSchema.parse(updates.recoveryProbeBudgets);
  }
  if (updates.sessionFailbackSettings !== undefined && updates.sessionFailbackSettings !== null) {
    SessionFailbackSettingsOverridesSchema.parse(updates.sessionFailbackSettings);
  }

  const current = await getSystemSettings();
  const [row] = await db
    .update(systemSettings)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(systemSettings.id, current.id))
    .returning({
      recoveryAuthorityMode: systemSettings.recoveryAuthorityMode,
      sessionBindingAuthorityMode: systemSettings.sessionBindingAuthorityMode,
      recoverySettings: systemSettings.recoverySettings,
      recoveryProbeBudgets: systemSettings.recoveryProbeBudgets,
      sessionFailbackSettings: systemSettings.sessionFailbackSettings,
    });
  if (!row) throw new Error("system recovery settings update returned no row");
  return row;
}

export async function updateProviderRecoveryConfiguration(
  providerId: number,
  updates: Pick<PersistedProviderRecoveryConfig, "recoverySettings" | "recoveryProbeBudgets">
): Promise<PersistedProviderRecoveryConfig | null> {
  if (updates.recoverySettings !== null) {
    RecoverySettingsOverridesSchema.parse(updates.recoverySettings);
  }
  if (updates.recoveryProbeBudgets !== null) {
    RecoveryProbeBudgetOverridesSchema.parse(updates.recoveryProbeBudgets);
  }
  const [row] = await db
    .update(providers)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(providers.id, providerId), isNull(providers.deletedAt)))
    .returning({
      providerId: providers.id,
      recoverySettings: providers.recoverySettings,
      recoveryProbeBudgets: providers.recoveryProbeBudgets,
    });
  return row ?? null;
}

export async function getKeyFailbackModeOverride(
  keyId: number
): Promise<SessionFailbackMode | null> {
  const [row] = await db
    .select({ mode: keys.sessionFailbackModeOverride })
    .from(keys)
    .where(and(eq(keys.id, keyId), isNull(keys.deletedAt)))
    .limit(1);
  return row?.mode ?? null;
}

export async function setKeyFailbackModeOverride(
  keyId: number,
  mode: SessionFailbackMode | null
): Promise<boolean> {
  const rows = await db
    .update(keys)
    .set({ sessionFailbackModeOverride: mode, updatedAt: new Date() })
    .where(and(eq(keys.id, keyId), isNull(keys.deletedAt)))
    .returning({ id: keys.id });
  return rows.length === 1;
}

export interface DegradedRecoveryEvidenceRecord {
  readonly scopeHash: string;
  readonly scope: RecoveryScope;
  readonly observedAt: Date;
  readonly failureClass: string;
  readonly sourceInstanceId: string;
  readonly evidenceCount: number;
  readonly reconciledAt: Date | null;
}

export async function upsertDegradedOpenEvidence(input: {
  readonly scope: RecoveryScope;
  readonly observedAt: Date;
  readonly failureClass: string;
  readonly sourceInstanceId: string;
}): Promise<DegradedRecoveryEvidenceRecord> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.failureClass)) {
    throw new TypeError("failureClass must be a bounded machine-readable identifier");
  }
  if (!input.sourceInstanceId || input.sourceInstanceId.length > 128) {
    throw new TypeError("sourceInstanceId must contain 1 through 128 characters");
  }
  const scopeHash = hashRecoveryScope(input.scope);
  const [row] = await db
    .insert(degradedRecoveryEvidence)
    .values({ scopeHash, ...input })
    .onConflictDoUpdate({
      target: degradedRecoveryEvidence.scopeHash,
      set: {
        scope: input.scope,
        observedAt: sql`greatest(${degradedRecoveryEvidence.observedAt}, ${input.observedAt})`,
        failureClass: input.failureClass,
        sourceInstanceId: input.sourceInstanceId,
        evidenceCount: sql`${degradedRecoveryEvidence.evidenceCount} + 1`,
        reconciledAt: null,
        updatedAt: new Date(),
      },
    })
    .returning({
      scopeHash: degradedRecoveryEvidence.scopeHash,
      scope: degradedRecoveryEvidence.scope,
      observedAt: degradedRecoveryEvidence.observedAt,
      failureClass: degradedRecoveryEvidence.failureClass,
      sourceInstanceId: degradedRecoveryEvidence.sourceInstanceId,
      evidenceCount: degradedRecoveryEvidence.evidenceCount,
      reconciledAt: degradedRecoveryEvidence.reconciledAt,
    });
  if (!row) throw new Error("degraded recovery evidence upsert returned no row");
  return row;
}

export async function listPendingDegradedOpenEvidence(
  limit = 100
): Promise<DegradedRecoveryEvidenceRecord[]> {
  const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  return db
    .select({
      scopeHash: degradedRecoveryEvidence.scopeHash,
      scope: degradedRecoveryEvidence.scope,
      observedAt: degradedRecoveryEvidence.observedAt,
      failureClass: degradedRecoveryEvidence.failureClass,
      sourceInstanceId: degradedRecoveryEvidence.sourceInstanceId,
      evidenceCount: degradedRecoveryEvidence.evidenceCount,
      reconciledAt: degradedRecoveryEvidence.reconciledAt,
    })
    .from(degradedRecoveryEvidence)
    .where(isNull(degradedRecoveryEvidence.reconciledAt))
    .orderBy(degradedRecoveryEvidence.observedAt)
    .limit(boundedLimit);
}

export async function markDegradedOpenEvidenceReconciled(
  scopeHashes: readonly string[],
  reconciledAt = new Date()
): Promise<number> {
  const uniqueHashes = [...new Set(scopeHashes)].filter((hash) => /^[a-f0-9]{64}$/.test(hash));
  if (uniqueHashes.length === 0) return 0;
  const rows = await db
    .update(degradedRecoveryEvidence)
    .set({ reconciledAt, updatedAt: reconciledAt })
    .where(
      and(
        inArray(degradedRecoveryEvidence.scopeHash, uniqueHashes),
        isNull(degradedRecoveryEvidence.reconciledAt)
      )
    )
    .returning({ scopeHash: degradedRecoveryEvidence.scopeHash });
  return rows.length;
}
