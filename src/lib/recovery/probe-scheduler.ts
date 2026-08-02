import { createHash, randomUUID } from "node:crypto";
import type { RecoveryProbeBudgets, RecoveryScope } from "./contracts";
import { canonicalizeRecoveryScope, hashRecoveryScope } from "./scope";

export interface DueSchedulerRedis {
  time(): Promise<[string, string]>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  zrangebyscore(
    key: string,
    minimum: number | string,
    maximum: number | string,
    ...args: Array<string | number>
  ): Promise<string[]>;
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  hget(key: string, field: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface ScheduledProbeService {
  getState(scope: RecoveryScope): Promise<{
    readonly health: string;
    readonly epoch: number;
    readonly nextProbeAt: number | null;
    readonly probeAttemptCount: number;
  } | null>;
  claimProbe(input: {
    readonly scope: RecoveryScope;
    readonly expectedEpoch: number;
    readonly leaseMs: number;
    readonly token?: string;
  }): Promise<
    | { readonly token: string; readonly epoch: number; readonly scope: RecoveryScope }
    | { readonly code: string }
  >;
  completeProbe(input: {
    readonly lease: {
      readonly token: string;
      readonly epoch: number;
      readonly scope: RecoveryScope;
    };
    readonly succeeded: boolean;
    readonly nextProbeDelayMs: number;
  }): Promise<unknown>;
}

export type ProbeExecutor = (input: {
  readonly scope: RecoveryScope;
  readonly safeModel: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}) => Promise<{
  readonly succeeded: boolean;
  readonly costUsd: number | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}>;

export type ProbeAccountingWriter = (input: {
  readonly scope: RecoveryScope;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly succeeded: boolean;
  readonly durationMs: number;
}) => Promise<unknown>;

const BUDGET_LUA = `
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local minute = math.floor(now_ms / 60000)
local day = math.floor(now_ms / 86400000)
local rpm_key = KEYS[1] .. ':' .. minute
local cost_key = KEYS[2] .. ':' .. day
local rpm = tonumber(redis.call('GET', rpm_key) or '0')
local cost = tonumber(redis.call('GET', cost_key) or '0')
if rpm >= tonumber(ARGV[1]) then return {0, 'rpm'} end
if cost + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return {0, 'daily_cost'} end
redis.call('INCR', rpm_key)
redis.call('PEXPIRE', rpm_key, 120000)
redis.call('INCRBYFLOAT', cost_key, ARGV[2])
redis.call('PEXPIRE', cost_key, 172800000)
return {1, 'ok'}
`;

const RENEW_LEADER_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const CONCURRENCY_LUA = `
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
if ARGV[1] == 'release' then
  redis.call('ZREM', KEYS[1], ARGV[2])
  return 1
end
if tonumber(redis.call('ZCARD', KEYS[1])) >= tonumber(ARGV[4]) then return 0 end
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local provider_count = 0
for _, member in ipairs(members) do
  if string.sub(member, 1, string.len(ARGV[3]) + 1) == ARGV[3] .. ':' then
    provider_count = provider_count + 1
  end
end
if provider_count >= tonumber(ARGV[5]) then return 0 end
redis.call('ZADD', KEYS[1], now_ms + tonumber(ARGV[6]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]) * 2)
return 1
`;

const SETTLE_COST_LUA = `
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local key = KEYS[1] .. ':' .. math.floor(now_ms / 86400000)
redis.call('INCRBYFLOAT', key, ARGV[1])
redis.call('PEXPIRE', key, 172800000)
return redis.call('GET', key)
`;

export function deterministicProbeBackoffMs(
  scope: RecoveryScope,
  attempt: number,
  baseMs = 5_000,
  maximumMs = 300_000
): number {
  const exponential = Math.min(maximumMs, baseMs * 2 ** Math.min(20, Math.max(0, attempt)));
  const digest = createHash("sha256")
    .update(`${hashRecoveryScope(scope)}:${attempt}`)
    .digest();
  const jitterBps = digest.readUInt16BE(0) % 2_001;
  return Math.min(maximumMs, Math.trunc(exponential * (0.9 + jitterBps / 10_000)));
}

export function parseCanonicalRecoveryScope(value: string): RecoveryScope {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed[0] !== "recovery-scope" || parsed[1] !== 1) {
    throw new TypeError("invalid canonical recovery scope");
  }
  if (parsed[2] === "provider") return { kind: "provider", providerId: Number(parsed[3]) };
  if (parsed[2] === "vendor-type") {
    return { kind: "vendor-type", vendorId: Number(parsed[3]), providerType: String(parsed[4]) };
  }
  if (parsed[2] === "capability") {
    return {
      kind: "capability",
      providerId: Number(parsed[3]),
      modelFamily: String(parsed[4]),
      transport: String(parsed[5]),
    };
  }
  if (parsed[2] === "endpoint") {
    return {
      kind: "endpoint",
      providerId: Number(parsed[3]),
      endpoint:
        parsed[4] === "managed"
          ? { kind: "managed", endpointId: Number(parsed[5]) }
          : { kind: "direct", endpointHash: String(parsed[5]) },
    };
  }
  throw new TypeError("unknown canonical recovery scope kind");
}

export class RecoveryDueScheduler {
  private readonly owner = randomUUID();
  private running = false;

  constructor(
    private readonly redis: DueSchedulerRedis,
    private readonly service: ScheduledProbeService,
    private readonly budgets: RecoveryProbeBudgets,
    private readonly execute: ProbeExecutor,
    private readonly options: {
      readonly batchSize?: number;
      readonly leaderLeaseMs?: number;
      readonly dueKey?: string;
      readonly accounting?: ProbeAccountingWriter;
      /** Conservative upper-bound cost reserved atomically before dispatch. */
      readonly reservedCostUsd?: number;
      /** A concrete Redis primary used only for bounded state-key scans. */
      readonly scanRedis?: DueSchedulerRedis;
    } = {}
  ) {}

  async schedule(scope: RecoveryScope, dueAt: number): Promise<void> {
    await this.redis.zadd(
      this.options.dueKey ?? "cb:v2:recovery_due",
      dueAt,
      canonicalizeRecoveryScope(scope)
    );
  }

  async tick(): Promise<number> {
    if (this.running || !this.budgets.safeModel) return 0;
    this.running = true;
    const leaseMs = this.options.leaderLeaseMs ?? 15_000;
    try {
      const acquired = await this.redis.set(
        "cb:v2:recovery_due:leader",
        this.owner,
        "PX",
        leaseMs,
        "NX"
      );
      if (acquired !== "OK" && (await this.redis.get("cb:v2:recovery_due:leader")) !== this.owner) {
        return 0;
      }
      const redisTime = await this.redis.time();
      const now = Number(redisTime[0]) * 1_000 + Math.trunc(Number(redisTime[1]) / 1_000);
      const members = await this.redis.zrangebyscore(
        this.options.dueKey ?? "cb:v2:recovery_due",
        "-inf",
        now,
        "LIMIT",
        0,
        this.options.batchSize ?? 50
      );
      let completed = 0;
      for (const member of members) {
        if ((await this.redis.get("cb:v2:recovery_due:leader")) !== this.owner) break;
        const scope = parseCanonicalRecoveryScope(member);
        const snapshot = await this.service.getState(scope);
        if (snapshot?.health !== "open") {
          await this.redis.zrem(this.options.dueKey ?? "cb:v2:recovery_due", member);
          continue;
        }
        const budget = await this.redis.eval(
          BUDGET_LUA,
          2,
          "cb:v2:probe:rpm",
          "cb:v2:probe:cost",
          String(this.budgets.requestsPerMinute),
          String(this.options.reservedCostUsd ?? this.budgets.dailyCostUsd),
          String(this.budgets.dailyCostUsd)
        );
        if (!Array.isArray(budget) || Number(budget[0]) !== 1) break;
        const providerKey =
          scope.kind === "vendor-type"
            ? `vendor-${scope.vendorId}`
            : `provider-${scope.providerId}`;
        const concurrencyToken = `${providerKey}:${randomUUID()}`;
        const concurrencyClaimed = await this.redis.eval(
          CONCURRENCY_LUA,
          1,
          "cb:v2:probe:concurrency",
          "claim",
          concurrencyToken,
          providerKey,
          String(this.budgets.globalConcurrency),
          String(this.budgets.providerConcurrency),
          String(this.budgets.timeoutMs + 1_000)
        );
        if (Number(concurrencyClaimed) !== 1) break;
        const claimed = await this.service.claimProbe({
          scope,
          expectedEpoch: snapshot.epoch,
          leaseMs: this.budgets.timeoutMs + 1_000,
        });
        if (!("token" in claimed)) {
          await this.redis.eval(
            CONCURRENCY_LUA,
            1,
            "cb:v2:probe:concurrency",
            "release",
            concurrencyToken,
            providerKey,
            "0",
            "0",
            "0"
          );
          continue;
        }
        const startedAt = Date.now();
        try {
          let result;
          try {
            result = await this.execute({
              scope,
              safeModel: this.budgets.safeModel,
              maxTokens: this.budgets.maxTokensPerProbe,
              timeoutMs: this.budgets.timeoutMs,
            });
          } catch (error) {
            await this.options.accounting?.({
              scope,
              model: this.budgets.safeModel,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: null,
              succeeded: false,
              durationMs: Date.now() - startedAt,
            });
            throw error;
          }
          await this.service.completeProbe({
            lease: claimed,
            succeeded: result.succeeded,
            nextProbeDelayMs: deterministicProbeBackoffMs(scope, snapshot.probeAttemptCount),
          });
          if (result.costUsd !== null) {
            const reservation = this.options.reservedCostUsd ?? this.budgets.dailyCostUsd;
            await this.redis.eval(
              SETTLE_COST_LUA,
              1,
              "cb:v2:probe:cost",
              String(result.costUsd - reservation)
            );
          }
          await this.options.accounting?.({
            scope,
            model: this.budgets.safeModel,
            inputTokens: result.inputTokens ?? 0,
            outputTokens: result.outputTokens ?? 0,
            costUsd: result.costUsd,
            succeeded: result.succeeded,
            durationMs: Date.now() - startedAt,
          });
        } finally {
          await this.redis.eval(
            CONCURRENCY_LUA,
            1,
            "cb:v2:probe:concurrency",
            "release",
            concurrencyToken,
            providerKey,
            "0",
            "0",
            "0"
          );
        }
        await this.redis.zrem(this.options.dueKey ?? "cb:v2:recovery_due", member);
        completed += 1;
      }
      await this.redis.eval(
        RENEW_LEADER_LUA,
        1,
        "cb:v2:recovery_due:leader",
        this.owner,
        String(leaseMs)
      );
      return completed;
    } finally {
      this.running = false;
    }
  }

  async reconcile(cursor = "0", count = 100): Promise<{ cursor: string; repaired: number }> {
    const scanRedis = this.options.scanRedis ?? this.redis;
    const [nextCursor, keys] = await scanRedis.scan(
      cursor,
      "MATCH",
      "cb:v2:*:state",
      "COUNT",
      count
    );
    let repaired = 0;
    for (const key of keys) {
      const [health, due, scopeJson] = await Promise.all([
        scanRedis.hget(key, "health"),
        scanRedis.hget(key, "next_probe_at"),
        scanRedis.hget(key, "scope_json"),
      ]);
      if (!scopeJson) continue;
      if (health === "open" && Number(due) > 0) {
        await this.schedule(parseCanonicalRecoveryScope(scopeJson), Number(due));
        repaired += 1;
      } else {
        await this.redis.zrem(this.options.dueKey ?? "cb:v2:recovery_due", scopeJson);
      }
    }
    return { cursor: nextCursor, repaired };
  }
}
