import { randomUUID } from "node:crypto";
import type { SessionBindingAuthorityMode } from "@/lib/recovery/contracts";
import { sessionBindingV2Keys } from "./session-binding-v2-keys";
import { SESSION_BINDING_V2_LUA } from "./session-binding-v2-lua";

export interface SessionProviderBindingV2 {
  readonly version: 2;
  readonly generation: number;
  readonly state: "stable" | "migrating";
  readonly providerId: number;
  readonly keyId: number | null;
  readonly effectivePriority: number;
  readonly bindingReason: "initial" | "failover" | "race_winner" | "failback";
  readonly failedOverFromProviderId: number | null;
  readonly failedOverFromPriority: number | null;
  readonly failedOverAt: number | null;
  readonly boundAt: number;
  readonly lastSuccessAt: number;
  readonly failbackCooldownUntil: number | null;
  readonly pendingProviderId: number | null;
  readonly pendingKeyId: number | null;
  readonly migrationLeaseToken: string | null;
  readonly migrationLeaseUntil: number | null;
  readonly migrationAttemptOutcomeId: string | null;
  readonly providerBoundFlags: readonly string[];
}

export interface BindingRedisClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export type BindingResultCode =
  | "applied"
  | "exists"
  | "not_found"
  | "malformed"
  | "stale_generation"
  | "stale_token"
  | "migrating"
  | "session_busy"
  | "invalid_operation";

export interface BindingResult {
  readonly code: BindingResultCode;
  readonly binding: SessionProviderBindingV2 | null;
  readonly details: readonly unknown[];
}

const CODES: Record<string, BindingResultCode> = {
  APPLIED: "applied",
  EXISTS: "exists",
  NOT_FOUND: "not_found",
  MALFORMED: "malformed",
  STALE_GENERATION: "stale_generation",
  STALE_TOKEN: "stale_token",
  MIGRATING: "migrating",
  SESSION_BUSY: "session_busy",
  INVALID_OPERATION: "invalid_operation",
};

function decode(raw: unknown): BindingResult {
  if (!Array.isArray(raw)) throw new TypeError("binding Lua result must be an array");
  const values = raw.map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value));
  const code = CODES[String(values[0])];
  if (!code) throw new TypeError(`unknown binding result: ${String(values[0])}`);
  let binding: SessionProviderBindingV2 | null = null;
  if (typeof values[1] === "string" && values[1].startsWith("{")) {
    binding = JSON.parse(values[1]) as SessionProviderBindingV2;
  }
  return { code, binding, details: values.slice(2) };
}

export class SessionBindingV2Service {
  constructor(
    private readonly redis: BindingRedisClient,
    private readonly ttlMs: number,
    private readonly authority: SessionBindingAuthorityMode,
    private readonly namespace: "production" | "shadow" = "production"
  ) {}

  private async run(sessionId: string, generation: number | undefined, args: readonly unknown[]) {
    const keys = sessionBindingV2Keys(sessionId, generation, this.namespace);
    return decode(
      await this.redis.eval(
        SESSION_BINDING_V2_LUA,
        4,
        keys.binding,
        keys.active,
        keys.providerCompatibility,
        keys.keyCompatibility,
        String(args[0]),
        String(this.ttlMs),
        this.authority === "v2_dual_write" ? "1" : "0",
        ...args.slice(1).map(String)
      )
    );
  }

  get(sessionId: string): Promise<BindingResult> {
    return this.run(sessionId, undefined, ["get"]);
  }

  create(input: {
    sessionId: string;
    providerId: number;
    keyId: number | null;
    effectivePriority: number;
    providerBoundFlags?: readonly string[];
  }): Promise<BindingResult> {
    return this.run(input.sessionId, 1, [
      "create",
      input.providerId,
      input.keyId ?? -1,
      input.effectivePriority,
      JSON.stringify(input.providerBoundFlags ?? []),
    ]);
  }

  claimRoute(input: {
    sessionId: string;
    generation: number;
    leaseMs: number;
    token?: string;
  }): Promise<BindingResult & { token: string }> {
    const token = input.token ?? randomUUID();
    return this.run(input.sessionId, input.generation, [
      "claim_route",
      input.generation,
      token,
      input.leaseMs,
    ]).then((result) => ({ ...result, token }));
  }

  renewRoute(input: {
    sessionId: string;
    generation: number;
    token: string;
    leaseMs: number;
  }): Promise<BindingResult> {
    return this.run(input.sessionId, input.generation, [
      "renew_route",
      input.generation,
      input.token,
      input.leaseMs,
    ]);
  }

  releaseRoute(input: {
    sessionId: string;
    generation: number;
    token: string;
  }): Promise<BindingResult> {
    return this.run(input.sessionId, input.generation, [
      "release_route",
      input.generation,
      input.token,
    ]);
  }

  commitRoute(input: {
    sessionId: string;
    expectedGeneration: number;
    providerId: number;
    keyId: number | null;
    effectivePriority: number;
    reason: "failover" | "race_winner";
  }): Promise<BindingResult> {
    return this.run(input.sessionId, input.expectedGeneration, [
      "commit_route",
      input.expectedGeneration,
      input.providerId,
      input.keyId ?? -1,
      input.effectivePriority,
      input.reason,
    ]);
  }

  prepareMigration(input: {
    sessionId: string;
    expectedGeneration: number;
    providerId: number;
    keyId: number | null;
    leaseMs: number;
    attemptOutcomeId: string;
    token?: string;
  }): Promise<BindingResult & { token: string }> {
    const token = input.token ?? randomUUID();
    return this.run(input.sessionId, input.expectedGeneration, [
      "prepare_migration",
      input.expectedGeneration,
      input.providerId,
      input.keyId ?? -1,
      token,
      input.leaseMs,
      input.attemptOutcomeId,
    ]).then((result) => ({ ...result, token }));
  }

  renewMigration(input: {
    sessionId: string;
    generation: number;
    token: string;
    leaseMs: number;
  }): Promise<BindingResult> {
    return this.run(input.sessionId, input.generation, [
      "renew_migration",
      input.generation,
      input.token,
      input.leaseMs,
    ]);
  }

  commitMigration(input: {
    sessionId: string;
    expectedGeneration: number;
    token: string;
    effectivePriority: number;
  }): Promise<BindingResult> {
    return this.run(input.sessionId, input.expectedGeneration, [
      "commit_migration",
      input.expectedGeneration,
      input.token,
      input.effectivePriority,
    ]);
  }

  abortMigration(input: {
    sessionId: string;
    expectedGeneration: number;
    token: string;
    cooldownMs?: number;
  }): Promise<BindingResult> {
    return this.run(input.sessionId, input.expectedGeneration, [
      "abort_migration",
      input.expectedGeneration,
      input.token,
      input.cooldownMs ?? 0,
    ]);
  }
}
