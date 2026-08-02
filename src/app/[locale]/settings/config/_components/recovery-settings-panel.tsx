"use client";

import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateRecoveryConfiguration } from "@/lib/api-client/v1/actions/recovery";

interface RecoverySettingsPanelProps {
  initialRecoveryAuthority: string;
  initialBindingAuthority: string;
  initialFailbackMode: string;
  initialRecoverySettings?: Record<string, number | boolean | null> | null;
  initialProbeBudgets?: Record<string, number | string | null> | null;
  initialFailbackSettings?: Record<string, number | string | null> | null;
  resolvedRecoverySettings?: Record<string, SettingResolution>;
  resolvedProbeBudgets?: Record<string, SettingResolution>;
  resolvedFailbackSettings?: Record<string, SettingResolution>;
  degraded?: boolean;
}

interface SettingResolution {
  configured: unknown;
  effective: unknown;
  source: "provider" | "system" | "environment" | "code" | "api_key";
}

const RECOVERY_NUMBER_FIELDS = [
  "openDurationMs",
  "windowDurationMs",
  "bucketDurationMs",
  "minimumRealOutcomes",
  "failureThreshold",
  "maximumFailureRate",
  "slowCallDurationMs",
  "maximumSlowCallRate",
  "consecutiveHard5xxThreshold",
  "rampDurationMs",
  "stableDurationMs",
  "halfOpenMaxConcurrency",
  "halfOpenSuccessThreshold",
  "stateRetentionMs",
] as const;
const RECOVERY_BOOLEAN_FIELDS = [
  "passiveHalfOpenEnabled",
  "recoveryTrafficEnabled",
  "activeProbesEnabled",
] as const;
const PROBE_FIELDS = [
  "safeModel",
  "globalConcurrency",
  "providerConcurrency",
  "requestsPerMinute",
  "maxTokensPerProbe",
  "timeoutMs",
  "dailyCostUsd",
] as const;
const FAILBACK_NUMBER_FIELDS = [
  "delayMs",
  "retryCooldownMs",
  "rolloutPercent",
  "maxConcurrentMigrations",
  "migrationWaitMs",
] as const;

function initialTextValues(
  fields: readonly string[],
  values: Record<string, number | string | boolean | null> | null | undefined
): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, String(values?.[field] ?? "")]));
}

function nullableNumbers(values: Record<string, string>): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.trim() === "" ? null : Number(value)])
  );
}

export function RecoverySettingsPanel({
  initialRecoveryAuthority,
  initialBindingAuthority,
  initialFailbackMode,
  initialRecoverySettings,
  initialProbeBudgets,
  initialFailbackSettings,
  resolvedRecoverySettings,
  resolvedProbeBudgets,
  resolvedFailbackSettings,
  degraded = false,
}: RecoverySettingsPanelProps) {
  const t = useTranslations("settings.recovery");
  const [recovery, setRecovery] = useState(initialRecoveryAuthority);
  const [binding, setBinding] = useState(initialBindingAuthority);
  const [failback, setFailback] = useState(initialFailbackMode);
  const [rolloutProof, setRolloutProof] = useState("none");
  const [recoveryNumbers, setRecoveryNumbers] = useState(() =>
    initialTextValues(RECOVERY_NUMBER_FIELDS, initialRecoverySettings)
  );
  const [recoveryBooleans, setRecoveryBooleans] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      RECOVERY_BOOLEAN_FIELDS.map((field) => [
        field,
        initialRecoverySettings?.[field] == null
          ? "inherit"
          : String(initialRecoverySettings[field]),
      ])
    )
  );
  const [probeBudgets, setProbeBudgets] = useState(() =>
    initialTextValues(PROBE_FIELDS, initialProbeBudgets)
  );
  const [failbackNumbers, setFailbackNumbers] = useState(() =>
    initialTextValues(FAILBACK_NUMBER_FIELDS, initialFailbackSettings)
  );
  const [pending, startTransition] = useTransition();
  const resolution = (settings: Record<string, SettingResolution> | undefined, field: string) => {
    const value = settings?.[field];
    if (!value) return null;
    return (
      <p className="text-xs text-muted-foreground" data-resolution={field}>
        {t("configuredValue", {
          configured: value.configured == null ? t("inherit") : String(value.configured),
          effective: String(value.effective),
          source: t(`sources.${value.source}`),
        })}
      </p>
    );
  };

  const save = () =>
    startTransition(async () => {
      try {
        await updateRecoveryConfiguration({
          recoveryAuthorityMode: recovery,
          sessionBindingAuthorityMode: binding,
          recoverySettings: {
            ...nullableNumbers(recoveryNumbers),
            ...Object.fromEntries(
              Object.entries(recoveryBooleans).map(([key, value]) => [
                key,
                value === "inherit" ? null : value === "true",
              ])
            ),
          },
          recoveryProbeBudgets: {
            ...nullableNumbers(
              Object.fromEntries(
                Object.entries(probeBudgets).filter(([key]) => key !== "safeModel")
              )
            ),
            safeModel: probeBudgets.safeModel.trim() || null,
          },
          sessionFailbackSettings: {
            mode: failback,
            ...nullableNumbers(failbackNumbers),
          },
          ...(rolloutProof === "none" ? {} : { rolloutProof }),
        });
        toast.success(t("saved"));
      } catch {
        toast.error(t("operationFailed"));
      }
    });

  return (
    <div className="grid gap-5 md:grid-cols-3">
      <div
        className="md:col-span-3 text-sm"
        role="status"
        data-degraded={degraded ? "true" : "false"}
      >
        {t("authority")}: {t(`authorities.${recovery}`)}; {t("bindingAuthority")}:{" "}
        {t(`authorities.${binding}`)}
        {degraded ? `; ${t("degraded")}` : ""}
      </div>
      <div className="space-y-2">
        <Label htmlFor="recovery-authority">{t("recoveryAuthority")}</Label>
        <Select value={recovery} onValueChange={setRecovery}>
          <SelectTrigger id="recovery-authority" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["legacy", "shadow", "enforce"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`authorities.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="rollout-proof">{t("rolloutProof")}</Label>
        <Select value={rolloutProof} onValueChange={setRolloutProof}>
          <SelectTrigger id="rollout-proof" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("rolloutProofNone")}</SelectItem>
            <SelectItem value="fleet_replaced">{t("fleetReplaced")}</SelectItem>
            <SelectItem value="maintenance_window">{t("maintenanceWindow")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <fieldset className="grid gap-4 md:col-span-3 md:grid-cols-3">
        <legend className="mb-3 text-sm font-medium">{t("recoveryDefaults")}</legend>
        {RECOVERY_NUMBER_FIELDS.map((field) => (
          <div className="space-y-2" key={field}>
            <Label htmlFor={`recovery-${field}`}>{t(`configFields.${field}`)}</Label>
            <Input
              id={`recovery-${field}`}
              type="number"
              value={recoveryNumbers[field]}
              placeholder={t("inherit")}
              onChange={(event) =>
                setRecoveryNumbers((current) => ({ ...current, [field]: event.target.value }))
              }
            />
            {resolution(resolvedRecoverySettings, field)}
          </div>
        ))}
        {RECOVERY_BOOLEAN_FIELDS.map((field) => (
          <div className="space-y-2" key={field}>
            <Label htmlFor={`recovery-${field}`}>{t(`configFields.${field}`)}</Label>
            <Select
              value={recoveryBooleans[field]}
              onValueChange={(value) =>
                setRecoveryBooleans((current) => ({ ...current, [field]: value }))
              }
            >
              <SelectTrigger id={`recovery-${field}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{t("inherit")}</SelectItem>
                <SelectItem value="true">{t("enabled")}</SelectItem>
                <SelectItem value="false">{t("disabled")}</SelectItem>
              </SelectContent>
            </Select>
            {resolution(resolvedRecoverySettings, field)}
          </div>
        ))}
      </fieldset>
      <fieldset className="grid gap-4 md:col-span-3 md:grid-cols-3">
        <legend className="mb-3 text-sm font-medium">{t("probeBudgets")}</legend>
        {PROBE_FIELDS.map((field) => (
          <div className="space-y-2" key={field}>
            <Label htmlFor={`probe-${field}`}>{t(`configFields.${field}`)}</Label>
            <Input
              id={`probe-${field}`}
              type={field === "safeModel" ? "text" : "number"}
              value={probeBudgets[field]}
              placeholder={t("inherit")}
              onChange={(event) =>
                setProbeBudgets((current) => ({ ...current, [field]: event.target.value }))
              }
            />
            {resolution(resolvedProbeBudgets, field)}
          </div>
        ))}
      </fieldset>
      <fieldset className="grid gap-4 md:col-span-3 md:grid-cols-3">
        <legend className="mb-3 text-sm font-medium">{t("sessionRouting")}</legend>
        {FAILBACK_NUMBER_FIELDS.map((field) => (
          <div className="space-y-2" key={field}>
            <Label htmlFor={`failback-${field}`}>{t(`configFields.${field}`)}</Label>
            <Input
              id={`failback-${field}`}
              type="number"
              value={failbackNumbers[field]}
              placeholder={t("inherit")}
              onChange={(event) =>
                setFailbackNumbers((current) => ({ ...current, [field]: event.target.value }))
              }
            />
            {resolution(resolvedFailbackSettings, field)}
          </div>
        ))}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="binding-authority">{t("bindingAuthority")}</Label>
        <Select value={binding} onValueChange={setBinding}>
          <SelectTrigger id="binding-authority" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["legacy", "shadow", "v2_dual_write", "v2_only"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`authorities.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="failback-mode">{t("failbackMode")}</Label>
        <Select value={failback} onValueChange={setFailback}>
          <SelectTrigger id="failback-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sticky">{t("sticky")}</SelectItem>
            <SelectItem value="safe_auto">{t("safeAuto")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="md:col-span-3">
        <Button onClick={save} disabled={pending} aria-busy={pending}>
          <Save className="h-4 w-4" />
          {t("save")}
        </Button>
      </div>
    </div>
  );
}
