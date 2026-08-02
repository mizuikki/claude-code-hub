export interface SessionBindingV2Keys {
  readonly binding: string;
  readonly active: string;
  readonly providerCompatibility: string;
  readonly keyCompatibility: string;
}

export function sessionBindingV2Keys(
  sessionId: string,
  generation?: number,
  namespace: "production" | "shadow" = "production"
): SessionBindingV2Keys {
  if (!sessionId || sessionId.length > 256 || /[{}\s]/.test(sessionId)) {
    throw new TypeError("sessionId must be a bounded opaque identifier");
  }
  const base = namespace === "shadow" ? `session:shadow:{${sessionId}}` : `session:{${sessionId}}`;
  return {
    binding: `${base}:binding:v2`,
    active: `${base}:active:${generation ?? "current"}`,
    providerCompatibility: `${base}:provider`,
    keyCompatibility: `${base}:key`,
  };
}

export const SESSION_FAILBACK_SEMAPHORE_KEY = "session:failback:migrations";
