"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Pause, Play, RotateCcw, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  getProviderRecoveryDiagnostics,
  operateProviderRecovery,
  updateProviderRecoveryConfiguration,
} from "@/lib/api-client/v1/actions/recovery";

const RECOVERY_OVERRIDE_FIELDS = [
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
const BOOLEAN_OVERRIDE_FIELDS = [
  "passiveHalfOpenEnabled",
  "recoveryTrafficEnabled",
  "activeProbesEnabled",
] as const;
const PROBE_OVERRIDE_FIELDS = [
  "globalConcurrency",
  "providerConcurrency",
  "requestsPerMinute",
  "maxTokensPerProbe",
  "timeoutMs",
  "dailyCostUsd",
] as const;

export function ProviderRecoveryDialog({ providerId }: { providerId: number }) {
  const t = useTranslations("settings.recovery");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [forceCloseConfirmed, setForceCloseConfirmed] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({});
  const [savingOverrides, setSavingOverrides] = useState(false);
  const [operating, setOperating] = useState(false);
  const query = useQuery({
    queryKey: ["provider-recovery", providerId],
    queryFn: () => getProviderRecoveryDiagnostics(providerId),
    enabled: open,
  });
  const state = query.data?.state;
  const effectiveSettings = query.data?.configuration.recovery;
  const effectiveProbeBudgets = query.data?.configuration.probeBudgets;
  useEffect(() => {
    if (!query.data) return;
    const next: Record<string, string> = {};
    for (const [group, fields] of Object.entries({
      recovery: query.data.configuration.recovery ?? {},
      probeBudgets: query.data.configuration.probeBudgets ?? {},
    })) {
      for (const [field, setting] of Object.entries(fields)) {
        next[`${group}.${field}`] = setting.configured == null ? "" : String(setting.configured);
      }
    }
    setOverrideDraft(next);
  }, [query.data]);

  async function saveOverrides() {
    const recoverySettings: Record<string, number | boolean | null> = {};
    const recoveryProbeBudgets: Record<string, number | string | null> = {};
    for (const field of RECOVERY_OVERRIDE_FIELDS) {
      const value = overrideDraft[`recovery.${field}`] ?? "";
      recoverySettings[field] = value === "" ? null : Number(value);
    }
    for (const field of BOOLEAN_OVERRIDE_FIELDS) {
      const value = overrideDraft[`recovery.${field}`] ?? "";
      recoverySettings[field] = value === "" ? null : value === "true";
    }
    const safeModel = overrideDraft["probeBudgets.safeModel"] ?? "";
    recoveryProbeBudgets.safeModel = safeModel.trim() || null;
    for (const field of PROBE_OVERRIDE_FIELDS) {
      const value = overrideDraft[`probeBudgets.${field}`] ?? "";
      recoveryProbeBudgets[field] = value === "" ? null : Number(value);
    }
    setSavingOverrides(true);
    try {
      await updateProviderRecoveryConfiguration(providerId, {
        recoverySettings,
        recoveryProbeBudgets,
      });
      await query.refetch();
      toast.success(t("providerOverridesSaved"));
    } catch {
      toast.error(t("providerOverridesSaveFailed"));
    } finally {
      setSavingOverrides(false);
    }
  }

  async function operate(
    action: "probe" | "pause" | "resume" | "reset" | "force-open" | "force-close"
  ) {
    if (!state || !reason.trim()) return;
    setOperating(true);
    try {
      await operateProviderRecovery(providerId, action, {
        expectedEpoch: state.epoch,
        reason,
        confirmation: action === "force-close" ? "FORCE_CLOSE" : undefined,
      });
      await query.refetch();
      setReason("");
      setForceCloseConfirmed(false);
      toast.success(t("operationComplete"));
    } catch {
      toast.error(t("operationFailed"));
    } finally {
      setOperating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          title={t("providerDiagnostics")}
          aria-label={t("providerDiagnostics")}
        >
          <Activity className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("providerDiagnostics")}</DialogTitle>
        </DialogHeader>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.isError ? (
          <p className="text-sm text-destructive">{t("loadFailed")}</p>
        ) : state ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={state.health === "closed" ? "default" : "destructive"}>
                {t(`states.${state.health}`)}
              </Badge>
              {state.automationPaused && <Badge variant="outline">{t("paused")}</Badge>}
              {query.data?.degraded && (
                <Badge variant="destructive">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  {t("degraded")}
                </Badge>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">{t("epoch")}</dt>
                <dd>{state.epoch}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("stage")}</dt>
                <dd>{state.recoveryStageIndex + 1}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("failures")}</dt>
                <dd>{state.failureCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("leases")}</dt>
                <dd>{state.trialOccupancy}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("authority")}</dt>
                <dd>{query.data?.authority.recovery}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("nextProbe")}</dt>
                <dd>
                  {state.nextProbeAt ? new Date(state.nextProbeAt).toLocaleString() : t("none")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("probeLease")}</dt>
                <dd>
                  {state.probeLeaseUntil
                    ? new Date(state.probeLeaseUntil).toLocaleString()
                    : t("none")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("probeAttempts")}</dt>
                <dd>{state.probeAttemptCount}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">{t("window")}</dt>
                <dd>
                  {t("windowSummary", {
                    total: state.window?.total ?? 0,
                    success: state.window?.success ?? 0,
                    failure: state.window?.failure ?? 0,
                    slow: state.window?.slow ?? 0,
                  })}
                </dd>
              </div>
            </dl>
            {(effectiveSettings || effectiveProbeBudgets) && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t("effectiveSettings")}</h3>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  {[
                    ...Object.entries(effectiveSettings ?? {}),
                    ...Object.entries(effectiveProbeBudgets ?? {}),
                  ].map(([field, setting]) => {
                    return (
                      <div key={field}>
                        <dt className="text-muted-foreground">{t(`configFields.${field}`)}</dt>
                        <dd>
                          {t("configuredValue", {
                            configured:
                              setting.configured == null
                                ? t("inherit")
                                : String(setting.configured),
                            effective: String(setting.effective),
                            source: t(`sources.${setting.source}`),
                          })}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            )}
            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-medium">{t("providerOverrides")}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {RECOVERY_OVERRIDE_FIELDS.map((field) => (
                  <label className="space-y-1 text-sm" key={field}>
                    <span>{t(`configFields.${field}`)}</span>
                    <Input
                      type="number"
                      value={overrideDraft[`recovery.${field}`] ?? ""}
                      placeholder={t("inherit")}
                      onChange={(event) =>
                        setOverrideDraft((current) => ({
                          ...current,
                          [`recovery.${field}`]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
                {BOOLEAN_OVERRIDE_FIELDS.map((field) => (
                  <label className="space-y-1 text-sm" key={field}>
                    <span>{t(`configFields.${field}`)}</span>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3"
                      value={overrideDraft[`recovery.${field}`] ?? ""}
                      onChange={(event) =>
                        setOverrideDraft((current) => ({
                          ...current,
                          [`recovery.${field}`]: event.target.value,
                        }))
                      }
                    >
                      <option value="">{t("inherit")}</option>
                      <option value="true">{t("enabled")}</option>
                      <option value="false">{t("disabled")}</option>
                    </select>
                  </label>
                ))}
                <label className="space-y-1 text-sm">
                  <span>{t("configFields.safeModel")}</span>
                  <Input
                    value={overrideDraft["probeBudgets.safeModel"] ?? ""}
                    placeholder={t("inherit")}
                    onChange={(event) =>
                      setOverrideDraft((current) => ({
                        ...current,
                        "probeBudgets.safeModel": event.target.value,
                      }))
                    }
                  />
                </label>
                {PROBE_OVERRIDE_FIELDS.map((field) => (
                  <label className="space-y-1 text-sm" key={field}>
                    <span>{t(`configFields.${field}`)}</span>
                    <Input
                      type="number"
                      value={overrideDraft[`probeBudgets.${field}`] ?? ""}
                      placeholder={t("inherit")}
                      onChange={(event) =>
                        setOverrideDraft((current) => ({
                          ...current,
                          [`probeBudgets.${field}`]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <Button onClick={saveOverrides} disabled={savingOverrides}>
                <Save className="h-4 w-4" />
                {t("saveProviderOverrides")}
              </Button>
            </div>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("reason")}
              aria-label={t("reason")}
            />
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={forceCloseConfirmed}
                onCheckedChange={(value) => setForceCloseConfirmed(value === true)}
                aria-label={t("forceCloseConfirmation")}
              />
              <span>{t("forceCloseConfirmation")}</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => operate("probe")}
                disabled={!reason.trim() || operating || query.data?.degraded}
              >
                <Activity className="h-4 w-4" />
                {t("probe")}
              </Button>
              <Button
                variant="outline"
                onClick={() => operate(state.automationPaused ? "resume" : "pause")}
                disabled={
                  !reason.trim() || operating || (query.data?.degraded && state.automationPaused)
                }
              >
                {state.automationPaused ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
                {state.automationPaused ? t("resume") : t("pause")}
              </Button>
              <Button
                variant="outline"
                onClick={() => operate("reset")}
                disabled={!reason.trim() || operating || query.data?.degraded}
              >
                <RotateCcw className="h-4 w-4" />
                {t("safeReset")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => operate("force-open")}
                disabled={!reason.trim() || operating}
              >
                <AlertTriangle className="h-4 w-4" />
                {t("forceOpen")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => operate("force-close")}
                disabled={
                  !reason.trim() || !forceCloseConfirmed || operating || query.data?.degraded
                }
              >
                <AlertTriangle className="h-4 w-4" />
                {t("forceClose")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noState")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
