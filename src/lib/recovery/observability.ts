import type { RecoveryHealth, RecoveryScope } from "./contracts";

export const RECOVERY_METRIC_CONTRACT = Object.freeze({
  "recovery.state": ["scope_kind", "to_state"],
  "recovery.transitions": ["scope_kind", "from_state", "to_state", "reason_class"],
  "recovery.attempts": ["scope_kind", "result", "authority"],
  "recovery.probes": ["scope_kind", "result"],
  "recovery.probe_duration": ["scope_kind", "result"],
  "recovery.probe_tokens": ["scope_kind", "result"],
  "recovery.probe_cost": ["scope_kind", "result"],
  "recovery.half_open_inflight": ["scope_kind"],
  "recovery.half_open_trials": ["scope_kind", "result"],
  "recovery.bps": ["scope_kind", "stage"],
  "recovery.reopens": ["scope_kind", "reason_class"],
  "recovery.duplicate_outcomes": ["scope_kind"],
  "recovery.due_index_drift": ["result"],
  "recovery.degraded": ["degraded"],
  "recovery.failback_attempts": ["result"],
  "recovery.failback_skips": ["skip_reason"],
  "recovery.failback_inflight": ["result"],
} as const);

const SCOPE_KINDS = ["provider", "vendor-type", "endpoint", "capability"] as const;
const HEALTH_STATES = ["closed", "open", "probing", "half_open", "recovering"] as const;
const DISPOSITIONS = ["success", "transient_failure", "hard_failure", "ignored"] as const;

export const RECOVERY_METRIC_ATTRIBUTE_VALUES = Object.freeze({
  scope_kind: SCOPE_KINDS,
  to_state: HEALTH_STATES,
  from_state: HEALTH_STATES,
  reason_class: ["admin", "probe", "transport", "upstream", "classified_outcome"],
  authority: ["legacy", "shadow", "enforce"],
  stage: ["0", "1", "2", "3", "4"],
  degraded: ["true", "false"],
  skip_reason: [
    "stateless",
    "sticky_mode",
    "not_failover_binding",
    "endpoint_not_replayable",
    "request_blocked",
    "origin_not_closed",
    "origin_not_stable",
    "origin_no_longer_preferred",
    "origin_not_higher_priority",
    "origin_ineligible",
    "delay_not_elapsed",
    "cooldown_active",
    "rollout_miss",
    "global_capacity",
    "session_busy",
    "migration_in_progress",
    "coordination_unavailable",
  ],
  result: [
    ...DISPOSITIONS,
    "claimed",
    "success",
    "failure",
    "known",
    "unknown",
    "priced",
    "unknown_cost",
    "repaired",
    "clean",
    "active",
    "dispatched",
    "committed",
    "commit_failed",
    "aborted",
  ],
} as const);

export const RECOVERY_METRIC_CARDINALITY_BUDGET = Object.freeze({
  instruments: Object.keys(RECOVERY_METRIC_CONTRACT).length,
  maximumSeriesPerInstrument: 100,
  maximumProviderSeries: 0,
});

export class RecoveryMetricRegistry {
  private readonly values = new Map<string, number>();

  add(instrument: string, value: number, attributes: Readonly<Record<string, string>>): void {
    const allowed = RECOVERY_METRIC_CONTRACT[instrument as keyof typeof RECOVERY_METRIC_CONTRACT];
    if (!allowed) throw new TypeError(`undeclared recovery metric instrument: ${instrument}`);
    for (const key of Object.keys(attributes)) {
      if (!(allowed as readonly string[]).includes(key))
        throw new TypeError(`recovery metric attribute is not allowed: ${key}`);
      const values = RECOVERY_METRIC_ATTRIBUTE_VALUES[
        key as keyof typeof RECOVERY_METRIC_ATTRIBUTE_VALUES
      ] as readonly string[] | undefined;
      if (!values?.includes(attributes[key])) {
        throw new TypeError(`recovery metric attribute value is not allowed: ${key}`);
      }
    }
    if (Object.keys(attributes).length !== allowed.length) {
      throw new TypeError("recovery metric attributes do not match the declared contract");
    }
    if (Object.values(attributes).some((entry) => entry.length > 32)) {
      throw new RangeError("recovery metric attribute exceeds cardinality budget");
    }
    const series = `${instrument}:${JSON.stringify(Object.entries(attributes).sort())}`;
    const instrumentSeries = [...this.values.keys()].filter((key) =>
      key.startsWith(`${instrument}:`)
    );
    if (
      !this.values.has(series) &&
      instrumentSeries.length >= RECOVERY_METRIC_CARDINALITY_BUDGET.maximumSeriesPerInstrument
    ) {
      throw new RangeError("recovery metric series budget exhausted");
    }
    this.values.set(series, (this.values.get(series) ?? 0) + value);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.values);
  }
}

export const recoveryMetrics = new RecoveryMetricRegistry();

export const RECOVERY_NOTIFICATION_CLASSES = [
  "opened",
  "active_probe_failed",
  "half_open",
  "recovering",
  "recovered",
  "reopened",
  "degraded_reconciliation_failed",
  "administrator_forced",
  "paused",
] as const;
export type RecoveryNotificationClass = (typeof RECOVERY_NOTIFICATION_CLASSES)[number];

export interface RecoveryNotificationEvent {
  readonly notificationClass: RecoveryNotificationClass;
  readonly scopeKind: RecoveryScope["kind"];
  readonly state: RecoveryHealth;
  readonly epoch: number;
}

export interface RecoveryTransitionLog {
  readonly event: "recovery_transition";
  readonly scopeKind: RecoveryScope["kind"];
  readonly from: RecoveryHealth;
  readonly to: RecoveryHealth;
  readonly epoch: number;
  readonly reasonClass: string;
}

export function recoveryTransitionLog(input: {
  scope: RecoveryScope;
  from: RecoveryHealth;
  to: RecoveryHealth;
  epoch: number;
  reasonClass: string;
}): RecoveryTransitionLog {
  if (!/^[a-z0-9._-]{1,32}$/.test(input.reasonClass)) throw new TypeError("invalid reason class");
  return {
    event: "recovery_transition",
    scopeKind: input.scope.kind,
    from: input.from,
    to: input.to,
    epoch: input.epoch,
    reasonClass: input.reasonClass,
  };
}

export interface RecoveryNotificationRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
}

export class RecoveryNotificationDeduplicator {
  constructor(
    private readonly redis: RecoveryNotificationRedis,
    private readonly ttlSeconds = 300
  ) {}

  async shouldNotify(input: {
    scopeHash: string;
    state: RecoveryHealth;
    epoch: number;
  }): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(input.scopeHash)) throw new TypeError("invalid scope hash");
    const result = await this.redis.set(
      `notification:recovery:${input.scopeHash}:${input.state}:${input.epoch}`,
      "1",
      "EX",
      this.ttlSeconds,
      "NX"
    );
    return result === "OK";
  }
}

export class RecoveryNotificationDispatcher {
  constructor(
    private readonly deduplicator: RecoveryNotificationDeduplicator,
    private readonly sink: (event: RecoveryNotificationEvent) => Promise<void>
  ) {}

  async dispatch(input: {
    scope: RecoveryScope;
    scopeHash: string;
    state: RecoveryHealth;
    epoch: number;
    notificationClass: RecoveryNotificationClass;
  }): Promise<boolean> {
    const shouldNotify = await this.deduplicator.shouldNotify(input);
    if (!shouldNotify) return false;
    await this.sink({
      notificationClass: input.notificationClass,
      scopeKind: input.scope.kind,
      state: input.state,
      epoch: input.epoch,
    });
    return true;
  }
}

export function notificationClassForState(
  state: RecoveryHealth,
  automationPaused: boolean
): RecoveryNotificationClass {
  if (automationPaused) return "paused";
  if (state === "open" || state === "probing") return "opened";
  if (state === "half_open") return "half_open";
  if (state === "recovering") return "recovering";
  return "recovered";
}

export function notificationClassForTransition(input: {
  from: RecoveryHealth;
  to: RecoveryHealth;
  automationPaused: boolean;
  reasonClass: string;
}): RecoveryNotificationClass {
  if (input.reasonClass.startsWith("admin") || input.reasonClass.startsWith("force_")) {
    return "administrator_forced";
  }
  if (input.to === "open" && (input.from === "recovering" || input.from === "half_open")) {
    return "reopened";
  }
  return notificationClassForState(input.to, input.automationPaused);
}
