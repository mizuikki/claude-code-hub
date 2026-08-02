import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { Section } from "@/components/section";
import { getCachedRecoveryConfiguration } from "@/lib/recovery/config-cache";
import { recoveryRuntimeIsDegraded } from "@/lib/recovery/runtime";
import { getPersistedRecoveryConfiguration } from "@/repository/recovery-config";
import { getSystemSettings } from "@/repository/system-config";
import { SettingsPageHeader } from "../_components/settings-page-header";
import { AutoCleanupForm } from "./_components/auto-cleanup-form";
import { RecoverySettingsPanel } from "./_components/recovery-settings-panel";
import { SettingsConfigSkeleton } from "./_components/settings-config-skeleton";
import { SystemSettingsForm } from "./_components/system-settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsConfigPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings" });

  return (
    <>
      <SettingsPageHeader
        title={t("config.title")}
        description={t("config.description")}
        icon="settings"
      />
      <Suspense fallback={<SettingsConfigSkeleton />}>
        <SettingsConfigContent locale={locale} />
      </Suspense>
    </>
  );
}

async function SettingsConfigContent({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "settings" });
  const settings = await getSystemSettings();
  const [persistedRecovery, resolvedRecovery] = await Promise.all([
    getPersistedRecoveryConfiguration(),
    getCachedRecoveryConfiguration(),
  ]);

  return (
    <>
      <Section
        title={t("recovery.title")}
        description={t("recovery.description")}
        icon="activity"
        variant="default"
      >
        <RecoverySettingsPanel
          initialRecoveryAuthority={persistedRecovery.system.recoveryAuthorityMode ?? "legacy"}
          initialBindingAuthority={persistedRecovery.system.sessionBindingAuthorityMode ?? "legacy"}
          initialFailbackMode={resolvedRecovery.failback.mode.effective}
          initialRecoverySettings={persistedRecovery.system.recoverySettings}
          initialProbeBudgets={persistedRecovery.system.recoveryProbeBudgets}
          initialFailbackSettings={persistedRecovery.system.sessionFailbackSettings}
          resolvedRecoverySettings={resolvedRecovery.recovery}
          resolvedProbeBudgets={resolvedRecovery.probeBudgets}
          resolvedFailbackSettings={resolvedRecovery.failback}
          degraded={recoveryRuntimeIsDegraded()}
        />
      </Section>

      <Section
        title={t("config.section.siteParams.title")}
        description={t("config.section.siteParams.description")}
        icon="settings"
        variant="default"
      >
        <SystemSettingsForm
          initialSettings={{
            siteTitle: settings.siteTitle,
            allowGlobalUsageView: settings.allowGlobalUsageView,
            currencyDisplay: settings.currencyDisplay,
            billingModelSource: settings.billingModelSource,
            codexPriorityBillingSource: settings.codexPriorityBillingSource,
            billNonSuccessfulRequests: settings.billNonSuccessfulRequests,
            billHedgeLosers: settings.billHedgeLosers,
            timezone: settings.timezone,
            verboseProviderError: settings.verboseProviderError,
            passThroughUpstreamErrorMessage: settings.passThroughUpstreamErrorMessage,
            enableHttp2: settings.enableHttp2,
            enableOpenaiResponsesWebsocket: settings.enableOpenaiResponsesWebsocket,
            enableHighConcurrencyMode: settings.enableHighConcurrencyMode,
            interceptAnthropicWarmupRequests: settings.interceptAnthropicWarmupRequests,
            enableThinkingSignatureRectifier: settings.enableThinkingSignatureRectifier,
            enableThinkingBudgetRectifier: settings.enableThinkingBudgetRectifier,
            enableThinkingEffortConflictRectifier: settings.enableThinkingEffortConflictRectifier,
            enableGeminiFunctionIdRectifier: settings.enableGeminiFunctionIdRectifier,
            enableBillingHeaderRectifier: settings.enableBillingHeaderRectifier,
            enableResponseInputRectifier: settings.enableResponseInputRectifier,
            allowNonConversationEndpointProviderFallback:
              settings.allowNonConversationEndpointProviderFallback,
            fakeStreamingWhitelist: settings.fakeStreamingWhitelist,
            enableCodexSessionIdCompletion: settings.enableCodexSessionIdCompletion,
            enableClaudeMetadataUserIdInjection: settings.enableClaudeMetadataUserIdInjection,
            enableResponseFixer: settings.enableResponseFixer,
            responseFixerConfig: settings.responseFixerConfig,
            quotaDbRefreshIntervalSeconds: settings.quotaDbRefreshIntervalSeconds,
            quotaLeasePercent5h: settings.quotaLeasePercent5h,
            quotaLeasePercentDaily: settings.quotaLeasePercentDaily,
            quotaLeasePercentWeekly: settings.quotaLeasePercentWeekly,
            quotaLeasePercentMonthly: settings.quotaLeasePercentMonthly,
            quotaLeaseCapUsd: settings.quotaLeaseCapUsd,
            ipGeoLookupEnabled: settings.ipGeoLookupEnabled,
            ipExtractionConfig: settings.ipExtractionConfig,
          }}
        />
      </Section>

      <Section
        title={t("config.section.autoCleanup.title")}
        description={t("config.section.autoCleanup.description")}
        icon="trash"
        iconColor="text-red-400"
        variant="default"
      >
        <AutoCleanupForm settings={settings} />
      </Section>
    </>
  );
}
