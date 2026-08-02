import type {
  BindingResult,
  SessionBindingV2Service,
  SessionProviderBindingV2,
} from "@/lib/redis/session-binding-v2-service";
import type { SessionBindingAuthorityMode } from "./contracts";

export class SessionBindingUnavailableError extends Error {
  readonly code: string = "session_binding_unavailable";
  readonly statusCode = 503;
  readonly retryAfterSeconds = 1;

  constructor(cause?: unknown) {
    super("session_binding_unavailable", { cause });
    this.name = "SessionBindingUnavailableError";
  }
}

export class SessionMigrationInProgressError extends SessionBindingUnavailableError {
  readonly code = "session_migration_in_progress";

  constructor(cause?: unknown) {
    super(cause);
    this.name = "SessionMigrationInProgressError";
  }
}

interface ActiveBindingRuntime {
  readonly mode: SessionBindingAuthorityMode;
  readonly production: SessionBindingV2Service | null;
  readonly shadow: SessionBindingV2Service | null;
}

let active: ActiveBindingRuntime = { mode: "legacy", production: null, shadow: null };

export function setSessionBindingRuntime(runtime: ActiveBindingRuntime): void {
  active = runtime;
}

export function getSessionBindingRuntime(): ActiveBindingRuntime {
  return active;
}

export function bindingV2IsAuthoritative(mode: SessionBindingAuthorityMode): boolean {
  return mode === "v2_dual_write" || mode === "v2_only";
}

export function bindingResultOrThrow(result: BindingResult): SessionProviderBindingV2 | null {
  if (result.code === "not_found") return null;
  if (result.code !== "applied" || !result.binding) {
    throw new SessionBindingUnavailableError(result.code);
  }
  return result.binding;
}
