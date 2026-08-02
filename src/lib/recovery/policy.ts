import type {
  ResolvedSetting,
  SessionFailbackMode,
  SessionFailbackModeOverride,
} from "./contracts";

export interface RecoverySettingLayers<T> {
  readonly provider: T | null;
  readonly system: T | null;
  readonly environment: T | null;
  readonly code: T;
}

export function resolveRecoverySetting<T>(layers: RecoverySettingLayers<T>): ResolvedSetting<T> {
  if (layers.provider !== null) {
    return { configured: layers.provider, effective: layers.provider, source: "provider" };
  }
  if (layers.system !== null) {
    return { configured: layers.system, effective: layers.system, source: "system" };
  }
  if (layers.environment !== null) {
    return { configured: null, effective: layers.environment, source: "environment" };
  }
  return { configured: null, effective: layers.code, source: "code" };
}

export interface FailbackModeLayers {
  readonly apiKey: SessionFailbackModeOverride;
  readonly system: SessionFailbackMode | null;
  readonly environment: SessionFailbackMode | null;
  readonly code: SessionFailbackMode;
}

export function resolveFailbackMode(
  layers: FailbackModeLayers
): ResolvedSetting<SessionFailbackMode> {
  if (layers.apiKey !== "inherit") {
    return { configured: layers.apiKey, effective: layers.apiKey, source: "api_key" };
  }
  if (layers.system !== null) {
    return { configured: layers.system, effective: layers.system, source: "system" };
  }
  if (layers.environment !== null) {
    return { configured: null, effective: layers.environment, source: "environment" };
  }
  return { configured: null, effective: layers.code, source: "code" };
}
